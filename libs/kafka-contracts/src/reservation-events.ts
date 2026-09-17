import { randomUUID } from 'crypto';
import type { Admin, Producer } from 'kafkajs';

/**
 * Kafka event contracts for the `reservation-events` topic (see PLAN.md §3).
 *
 * Single topic, multiple event types, partitioned by `slotId` so that one
 * slot's lifecycle (Requested -> Confirmed/Cancelled -> SlotReleased) is
 * always consumed in order. Do not split these into per-type topics --
 * Kafka only orders within one partition of one topic, and slot-lifecycle
 * ordering is a hard correctness requirement for inventory-sync consumers.
 */

export type ReservationEventType =
  | 'ReservationRequested'
  | 'ReservationConfirmed'
  | 'ReservationCancelled'
  | 'SlotReleased';

export interface EventEnvelope<T extends ReservationEventType, P> {
  eventId: string; // UUID v4 -- dedupe key for idempotent consumers, generated once at publish time
  eventType: T;
  occurredAt: string; // ISO 8601, set at the moment the fact became true
  version: 1;
  slotId: string; // == Kafka partition key
  locationId: string;
  correlationId: string; // ties back to the originating HTTP request / hold
  payload: P;
}

export interface ReservationRequestedPayload {
  reservationId: string;
  userId: string;
  holdId: string;
  requestedAt: string;
}

export interface ReservationConfirmedPayload {
  reservationId: string;
  userId: string;
  confirmedAt: string;
  slotStartTime: string;
  slotEndTime: string;
}

export interface ReservationCancelledPayload {
  reservationId: string;
  userId: string;
  cancelledAt: string;
  reason: 'user_cancelled' | 'hold_expired' | 'admin_cancelled';
}

export interface SlotReleasedPayload {
  slotId: string;
  releasedCapacity: number;
  reason: 'cancellation' | 'hold_expired' | 'capacity_adjustment';
}

export type ReservationEvent =
  | EventEnvelope<'ReservationRequested', ReservationRequestedPayload>
  | EventEnvelope<'ReservationConfirmed', ReservationConfirmedPayload>
  | EventEnvelope<'ReservationCancelled', ReservationCancelledPayload>
  | EventEnvelope<'SlotReleased', SlotReleasedPayload>;

export const RESERVATION_EVENTS_TOPIC = 'reservation-events';

/**
 * `partitions: 12` gives headroom to scale `event-consumer` instances
 * independently of Redis/Postgres sharding (PLAN.md §3).
 * `replicationFactor` is passed in rather than hardcoded -- 1 for a single
 * local broker, 3 in non-local envs, per PLAN.md §3.
 */
export async function ensureReservationEventsTopic(
  admin: Admin,
  replicationFactor: number,
): Promise<void> {
  const existing = await admin.listTopics();
  if (existing.includes(RESERVATION_EVENTS_TOPIC)) {
    return;
  }
  await admin.createTopics({
    waitForLeaders: true,
    topics: [{ topic: RESERVATION_EVENTS_TOPIC, numPartitions: 12, replicationFactor }],
  });
}

/**
 * Envelopes and publishes one reservation lifecycle event, keyed by
 * `slotId` so all of one slot's events land in the same partition and are
 * consumed in order (PLAN.md §3). Shared by every producer (today: only
 * `apps/api`) so the envelope shape can't drift between call sites.
 */
export async function publishReservationEvent<T extends ReservationEventType>(
  producer: Producer,
  eventType: T,
  args: {
    slotId: string;
    locationId: string;
    correlationId: string;
    payload: Extract<ReservationEvent, { eventType: T }>['payload'];
  },
): Promise<string> {
  const eventId = randomUUID();
  const event: EventEnvelope<T, typeof args.payload> = {
    eventId,
    eventType,
    occurredAt: new Date().toISOString(),
    version: 1,
    slotId: args.slotId,
    locationId: args.locationId,
    correlationId: args.correlationId,
    payload: args.payload,
  };

  await producer.send({
    topic: RESERVATION_EVENTS_TOPIC,
    messages: [
      {
        key: args.slotId,
        value: JSON.stringify(event),
        headers: { eventType, eventId },
      },
    ],
  });

  return eventId;
}
