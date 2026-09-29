import { Inject, Injectable } from '@nestjs/common';
import type { Producer } from 'kafkajs';
import {
  publishReservationEvent,
  ReservationCancelledPayload,
  ReservationConfirmedPayload,
  ReservationRequestedPayload,
  SlotReleasedPayload,
} from '@lib/kafka-contracts';
import { KAFKA_PRODUCER } from '@app/api/modules/kafka/kafka-producer.provider';

interface EventContext {
  slotId: string;
  locationId: string;
  correlationId: string;
}

/**
 * Publishes reservation lifecycle events to Kafka (docs/architecture.md §4: "Direct
 * producer call from within the request path" -- fire-and-forget to the
 * durable log, no retry policy needed beyond Kafka's own).
 */
@Injectable()
export class EventsPublisherService {
  constructor(@Inject(KAFKA_PRODUCER) private readonly producer: Producer) {}

  async publishReservationRequested(
    ctx: EventContext,
    payload: ReservationRequestedPayload,
  ): Promise<void> {
    await publishReservationEvent(this.producer, 'ReservationRequested', { ...ctx, payload });
  }

  async publishReservationConfirmed(
    ctx: EventContext,
    payload: ReservationConfirmedPayload,
  ): Promise<void> {
    await publishReservationEvent(this.producer, 'ReservationConfirmed', { ...ctx, payload });
  }

  async publishReservationCancelled(
    ctx: EventContext,
    payload: ReservationCancelledPayload,
  ): Promise<void> {
    await publishReservationEvent(this.producer, 'ReservationCancelled', { ...ctx, payload });
  }

  async publishSlotReleased(ctx: EventContext, payload: SlotReleasedPayload): Promise<void> {
    await publishReservationEvent(this.producer, 'SlotReleased', { ...ctx, payload });
  }
}
