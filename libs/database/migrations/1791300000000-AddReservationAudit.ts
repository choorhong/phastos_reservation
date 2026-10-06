import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Audit history of reservation events (one row per Kafka event), written by
 * event-consumer and read by admins via `GET /audit`. See
 * `ReservationAudit`. No foreign keys on purpose: history must outlive what
 * it describes. Indexed for the three ways it's looked up, each in time
 * order.
 */
export class AddReservationAudit1791300000000 implements MigrationInterface {
  name = 'AddReservationAudit1791300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE reservation_audit (
        event_id UUID PRIMARY KEY,
        event_type VARCHAR NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        slot_id UUID NOT NULL,
        location_id UUID NOT NULL,
        reservation_id UUID,
        user_id UUID,
        correlation_id VARCHAR NOT NULL,
        payload JSONB NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_reservation_audit_reservation ON reservation_audit (reservation_id, occurred_at) WHERE reservation_id IS NOT NULL;`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_reservation_audit_user ON reservation_audit (user_id, occurred_at) WHERE user_id IS NOT NULL;`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_reservation_audit_slot ON reservation_audit (slot_id, occurred_at);`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS reservation_audit;`);
  }
}
