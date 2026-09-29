import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Locations, slots, reservations, plus `enforce_slot_capacity`: a trigger
 * that is the hard backstop against overbooking (docs/architecture.md §2 "defense in
 * depth"). Redis is the fast path that rejects most over-capacity claims
 * before they ever reach Postgres; this trigger is what makes it physically
 * impossible for `reservations` to hold more `confirmed` rows for a slot
 * than that slot's `capacity`, regardless of what happened upstream.
 */
export class InitialSchema1789211003000 implements MigrationInterface {
  name = 'InitialSchema1789211003000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

    await queryRunner.query(`
      CREATE TABLE locations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR NOT NULL,
        address VARCHAR NOT NULL,
        timezone VARCHAR NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await queryRunner.query(`
      CREATE TABLE slots (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        start_time TIMESTAMPTZ NOT NULL,
        end_time TIMESTAMPTZ NOT NULL,
        capacity INT NOT NULL CHECK (capacity >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_slots_location_start ON slots(location_id, start_time);`,
    );

    await queryRunner.query(`
      CREATE TABLE reservations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slot_id UUID NOT NULL REFERENCES slots(id) ON DELETE RESTRICT,
        user_id VARCHAR NOT NULL,
        hold_id VARCHAR NOT NULL UNIQUE,
        status VARCHAR NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'confirmed', 'cancelled', 'expired')),
        correlation_id VARCHAR,
        confirmed_at TIMESTAMPTZ,
        cancelled_at TIMESTAMPTZ,
        cancel_reason VARCHAR,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_reservations_slot_status ON reservations(slot_id, status);`,
    );

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION enforce_slot_capacity() RETURNS TRIGGER AS $$
      DECLARE
        slot_capacity INT;
        confirmed_count INT;
      BEGIN
        IF NEW.status <> 'confirmed' THEN
          RETURN NEW;
        END IF;

        -- Lock the slot row so concurrent confirms for the same slot
        -- serialize here instead of racing each other's capacity check.
        SELECT capacity INTO slot_capacity FROM slots WHERE id = NEW.slot_id FOR UPDATE;

        SELECT COUNT(*) INTO confirmed_count
        FROM reservations
        WHERE slot_id = NEW.slot_id
          AND status = 'confirmed'
          AND id <> NEW.id;

        IF confirmed_count >= slot_capacity THEN
          RAISE EXCEPTION 'SLOT_CAPACITY_EXCEEDED: slot % has capacity % and already has % confirmed reservations',
            NEW.slot_id, slot_capacity, confirmed_count
            USING ERRCODE = 'check_violation';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      CREATE TRIGGER trg_enforce_slot_capacity
        BEFORE INSERT OR UPDATE OF status ON reservations
        FOR EACH ROW
        EXECUTE FUNCTION enforce_slot_capacity();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_enforce_slot_capacity ON reservations;`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS enforce_slot_capacity();`);
    await queryRunner.query(`DROP TABLE IF EXISTS reservations;`);
    await queryRunner.query(`DROP TABLE IF EXISTS slots;`);
    await queryRunner.query(`DROP TABLE IF EXISTS locations;`);
  }
}
