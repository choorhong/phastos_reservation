import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Logger } from 'nestjs-pino';
import type { Consumer, EachMessagePayload } from 'kafkajs';
import { Repository } from 'typeorm';
import { ProcessedEvent } from '@app/database';
import { ReservationEvent } from '@app/kafka-contracts';
import { KAFKA_CONSUMER } from '../kafka/kafka-consumer.provider';

const CONSUMER_NAME = 'event-consumer';

/**
 * Consumes `reservation-events` (PLAN.md §3). There's no real
 * analytics/audit/inventory-sync integration yet -- this stands in for all
 * three at once and just logs, the same scope boundary as
 * `NotificationConsumersService`'s stand-in send logic. What this exists to
 * get right at this stage is the idempotent-consumption pattern: claim the
 * event with `INSERT ... ON CONFLICT (event_id, consumer_name) DO NOTHING`
 * *before* doing anything else, so a redelivered event (consumer restart,
 * rebalance, at-least-once redelivery) is a no-op rather than a duplicate
 * side effect.
 */
@Injectable()
export class EventsConsumerService implements OnModuleInit {
  constructor(
    @Inject(KAFKA_CONSUMER) private readonly consumer: Consumer,
    @InjectRepository(ProcessedEvent) private readonly processedEvents: Repository<ProcessedEvent>,
    private readonly logger: Logger,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.consumer.run({ eachMessage: (payload) => this.handleMessage(payload) });
  }

  private async handleMessage({ message }: EachMessagePayload): Promise<void> {
    if (!message.value) {
      return;
    }
    const event = JSON.parse(message.value.toString('utf8')) as ReservationEvent;

    // Raw query + RETURNING rather than the query builder's .orIgnore():
    // ProcessedEvent's primary key columns aren't DB-generated, so TypeORM
    // populates InsertResult.identifiers from the *input* values regardless
    // of whether Postgres actually inserted the row or silently discarded
    // it via ON CONFLICT DO NOTHING -- identifiers.length is always 1 either
    // way, so it can't tell a genuine insert from a no-op. RETURNING can.
    const inserted: unknown[] = await this.processedEvents.manager.query(
      `INSERT INTO processed_events (event_id, consumer_name) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING event_id`,
      [event.eventId, CONSUMER_NAME],
    );

    if (inserted.length === 0) {
      this.logger.log(
        { eventId: event.eventId, eventType: event.eventType },
        'reservation_event.duplicate_skipped',
      );
      return;
    }

    this.logger.log(
      {
        eventId: event.eventId,
        eventType: event.eventType,
        slotId: event.slotId,
        correlationId: event.correlationId,
      },
      'reservation_event.processed',
    );
  }
}
