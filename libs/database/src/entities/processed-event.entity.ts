import { CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * Idempotent-consumption ledger for Kafka `reservation-events` consumers
 * (docs/architecture.md §3). Composite primary key `(event_id, consumer_name)` rather
 * than `event_id` alone: multiple downstream consumers (analytics, audit,
 * inventory-sync) each dedupe independently against the same eventId, so
 * one consumer having already processed an event must not block another.
 *
 * A consumer claims an event with `INSERT ... ON CONFLICT DO NOTHING`
 * before applying its side effect -- the unique constraint on the primary
 * key is what makes a redelivered event a no-op instead of a duplicate
 * side effect.
 */
@Entity('processed_events')
export class ProcessedEvent {
  @PrimaryColumn({ name: 'event_id' })
  eventId: string;

  @PrimaryColumn({ name: 'consumer_name' })
  consumerName: string;

  @CreateDateColumn({ name: 'processed_at', type: 'timestamptz' })
  processedAt: Date;
}
