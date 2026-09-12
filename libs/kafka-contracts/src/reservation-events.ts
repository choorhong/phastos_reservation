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
  reason: 'user_cancelled' | 'hold_expired' | 'admin_cancelled' | 'payment_failed';
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
