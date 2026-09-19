import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import type { UserRole } from '@lib/domain';

/**
 * `role` gates the admin-only endpoints (`POST /locations`, `POST /slots`)
 * via `RolesGuard` (`apps/api/src/modules/auth`). Self-registration
 * (`AuthService.register`) always creates `role: 'user'` -- an admin
 * account can only come from the env-driven bootstrap in `AuthModule`, so
 * nobody can grant themselves admin through the public API.
 */
@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  email: string;

  @Column({ name: 'password_hash' })
  passwordHash: string;

  @Column({ type: 'varchar', default: 'user' })
  role: UserRole;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
