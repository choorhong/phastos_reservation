import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Idempotent-consumption ledger for Kafka `reservation-events` consumers
 * (docs/architecture.md §3): a consumer claims an event with
 * `INSERT ... ON CONFLICT (event_id, consumer_name) DO NOTHING` before
 * applying its side effect, so a redelivered event is a no-op rather than a
 * duplicate side effect. Composite PK (not `event_id` alone) because
 * multiple downstream consumers dedupe independently against the same
 * eventId.
 */
export class AddProcessedEvents1789465789679 implements MigrationInterface {
  name = 'AddProcessedEvents1789465789679';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE processed_events (
        event_id UUID NOT NULL,
        consumer_name VARCHAR NOT NULL,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (event_id, consumer_name)
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS processed_events;`);
  }
}
