import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One person may hold at most one spot in a slot. The API checks this before
 * claiming a spot in Redis (a clean 409); this partial unique index is what
 * makes it hold when two requests from the same user race past that check.
 *
 * Only `held` and `confirmed` rows count: a cancelled or expired reservation
 * frees the user to book the same slot again.
 *
 * Fails if existing rows already break the rule. Find them with:
 *   SELECT slot_id, user_id, count(*) FROM reservations
 *   WHERE status IN ('held', 'confirmed') GROUP BY 1, 2 HAVING count(*) > 1;
 * and cancel the extras by hand first.
 */
export class OneActiveReservationPerUserPerSlot1789911000000 implements MigrationInterface {
  name = 'OneActiveReservationPerUserPerSlot1789911000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_reservations_active_user_slot
         ON reservations(slot_id, user_id)
         WHERE status IN ('held', 'confirmed');`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX uq_reservations_active_user_slot;`);
  }
}
