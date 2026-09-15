import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backs the reminder DB-scheduler-sweep design (PLAN.md "Decisions" #2):
 * notification-worker periodically selects confirmed reservations whose
 * slot starts within the reminder lead window and `reminder_sent_at IS
 * NULL`, conditionally claims one with an `UPDATE ... WHERE reminder_sent_at
 * IS NULL` (so concurrent sweep runs can't double-claim it), then enqueues
 * to RabbitMQ. Once set, a reservation is never picked up by the sweep
 * again -- no separate "window" bookkeeping needed.
 */
export class AddReminderSentAtToReservations1789463728849 implements MigrationInterface {
  name = 'AddReminderSentAtToReservations1789463728849';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE reservations ADD COLUMN reminder_sent_at TIMESTAMPTZ;
    `);
    await queryRunner.query(`
      CREATE INDEX idx_reservations_reminder_pending
        ON reservations(status)
        WHERE reminder_sent_at IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_reservations_reminder_pending;`);
    await queryRunner.query(`ALTER TABLE reservations DROP COLUMN reminder_sent_at;`);
  }
}
