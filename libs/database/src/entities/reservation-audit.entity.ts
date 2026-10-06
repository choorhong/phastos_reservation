import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import type { ReservationEventType } from '@lib/kafka-contracts';

/**
 * One row per Kafka `reservation-events` event, written by `event-consumer`
 * in the same transaction as its `processed_events` claim, so each event is
 * recorded exactly once. Read by admins through `GET /audit` (api).
 *
 * Append-only history: no foreign keys to reservations/slots/users, so the
 * record outlives whatever it describes. `reservationId`/`userId` are null
 * for `SlotReleased`, which is about a slot, not a reservation. `payload` is
 * the event's payload exactly as published. The indexes (by reservation,
 * user and slot, each with `occurred_at`) live in the migration.
 */
@Entity('reservation_audit')
export class ReservationAudit {
  @PrimaryColumn({ name: 'event_id', type: 'uuid' })
  eventId: string;

  @Column({ name: 'event_type', type: 'varchar' })
  eventType: ReservationEventType;

  /** When the fact became true (the event's `occurredAt`). */
  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt: Date;

  @Column({ name: 'slot_id', type: 'uuid' })
  slotId: string;

  @Column({ name: 'location_id', type: 'uuid' })
  locationId: string;

  @Column({ name: 'reservation_id', type: 'uuid', nullable: true })
  reservationId: string | null;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ name: 'correlation_id', type: 'varchar' })
  correlationId: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  /** When event-consumer stored it (normally a fraction of a second after `occurredAt`). */
  @CreateDateColumn({ name: 'recorded_at', type: 'timestamptz' })
  recordedAt: Date;
}
