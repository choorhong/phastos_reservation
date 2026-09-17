/**
 * Plain value types shared across apps (api, notification-worker,
 * event-consumer). TypeORM entities live in `@lib/database`, not here —
 * this lib is for types with no persistence framework dependency, safe to
 * import from any process including ones that never touch Postgres.
 */

export interface TimeRange {
  startTime: string; // ISO 8601
  endTime: string; // ISO 8601
}

export type ReservationStatus = 'held' | 'confirmed' | 'cancelled' | 'expired';

export type ReservationCancelReason = 'user_cancelled' | 'hold_expired' | 'admin_cancelled';

export type SlotReleaseReason = 'cancellation' | 'hold_expired' | 'capacity_adjustment';
