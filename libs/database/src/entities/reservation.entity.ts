import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { ReservationCancelReason, ReservationStatus } from '@app/domain';
import { Slot } from './slot.entity';

/**
 * Row of record for one booking. `holdId` carries the Redis hold that
 * produced this row and is UNIQUE: if the confirm path is retried (e.g. the
 * app crashes after the Redis `confirmHold` script runs but before this
 * insert commits), re-inserting with the same holdId hits the unique
 * constraint instead of creating a duplicate reservation -- this is what
 * makes "confirm" idempotent from the Postgres side.
 *
 * `enforce_slot_capacity` (DB trigger, added in the initial migration) is
 * the hard backstop against overbooking: it locks the slot row and re-counts
 * confirmed reservations before allowing this row to become 'confirmed',
 * so capacity is enforced here even if Redis is bypassed, stale, or lost.
 */
@Entity('reservations')
@Index(['slotId', 'status'])
export class Reservation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'slot_id' })
  slotId: string;

  @ManyToOne(() => Slot, (slot) => slot.reservations, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'slot_id' })
  slot: Slot;

  @Column({ name: 'user_id' })
  userId: string;

  @Column({ name: 'hold_id', unique: true })
  holdId: string;

  @Column({ type: 'varchar', default: 'held' })
  status: ReservationStatus;

  @Column({ name: 'correlation_id', nullable: true })
  correlationId?: string;

  @Column({ name: 'confirmed_at', type: 'timestamptz', nullable: true })
  confirmedAt?: Date;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt?: Date;

  @Column({ name: 'cancel_reason', type: 'varchar', nullable: true })
  cancelReason?: ReservationCancelReason;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
