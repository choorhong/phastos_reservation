import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backs JWT auth (`apps/api/src/modules/auth`). `role` is checked in
 * Postgres (not just application code) so a direct/manual row insert can't
 * silently create an account outside the `user`/`admin` vocabulary.
 */
export class AddUsers1789798628495 implements MigrationInterface {
  name = 'AddUsers1789798628495';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR NOT NULL UNIQUE,
        password_hash VARCHAR NOT NULL,
        role VARCHAR NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS users;`);
  }
}
