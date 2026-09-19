import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Location } from './location.entity';
import { Reservation } from './reservation.entity';

/**
 * `capacity` is the total number of bookable spots for this slot. It is the
 * number Postgres enforces against (see the `enforce_slot_capacity` trigger
 * added in the initial migration) and the number Redis's
 * `slot:{slotId}:available` counter is seeded from at cache-load time
 * (PLAN.md §2). Postgres is the source of truth for this value; Redis is a
 * cache of it plus in-flight holds.
 *
 * `(locationId, startTime)` is UNIQUE so the slot generator can re-run
 * safely (`INSERT ... ON CONFLICT DO NOTHING`).
 */
@Entity('slots')
@Index('uq_slots_location_start', ['locationId', 'startTime'], { unique: true })
export class Slot {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'location_id' })
  locationId: string;

  @ManyToOne(() => Location, (location) => location.slots, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'location_id' })
  location: Location;

  @Column({ name: 'start_time', type: 'timestamptz' })
  startTime: Date;

  @Column({ name: 'end_time', type: 'timestamptz' })
  endTime: Date;

  @Column({ type: 'int' })
  capacity: number;

  @OneToMany(() => Reservation, (reservation) => reservation.slot)
  reservations: Reservation[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
