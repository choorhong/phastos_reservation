import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Logger } from 'nestjs-pino';
import type { Consumer, EachMessagePayload } from 'kafkajs';
import { Repository } from 'typeorm';
import { ProcessedEvent } from '@lib/database';
import { ReservationEvent } from '@lib/kafka-contracts';
import { KAFKA_CONSUMER } from '@app/event-consumer/modules/kafka/kafka-consumer.provider';

const CONSUMER_NAME = 'event-consumer';

/**
 * Consumes `reservation-events` (docs/architecture.md §3) and records each
 * event in `reservation_audit` (read by admins via `GET /audit`).
 *
 * Idempotent: the event is claimed with `INSERT ... ON CONFLICT
 * (event_id, consumer_name) DO NOTHING` and, only if that claim is new, the
 * audit row is written -- both in one transaction. A redelivered event
 * (consumer restart, rebalance, at-least-once delivery) is a no-op, and a
 * crash between the two can't leave an event claimed but unrecorded (or
 * recorded twice): either both commit or neither does, and Kafka redelivers.
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
    const recorded = await this.processedEvents.manager.transaction(async (manager) => {
      const inserted: unknown[] = await manager.query(
        `INSERT INTO processed_events (event_id, consumer_name) VALUES ($1, $2)
         ON CONFLICT DO NOTHING RETURNING event_id`,
        [event.eventId, CONSUMER_NAME],
      );
      if (inserted.length === 0) {
        return false;
      }
      await manager.query(
        `INSERT INTO reservation_audit
           (event_id, event_type, occurred_at, slot_id, location_id,
            reservation_id, user_id, correlation_id, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          event.eventId,
          event.eventType,
          event.occurredAt,
          event.slotId,
          event.locationId,
          // SlotReleased is about a slot, not a reservation: no reservation or user.
          'reservationId' in event.payload ? event.payload.reservationId : null,
          'userId' in event.payload ? event.payload.userId : null,
          event.correlationId,
          JSON.stringify(event.payload),
        ],
      );
      return true;
    });

    if (!recorded) {
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
