import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, FindOptionsWhere, In, MoreThanOrEqual, Repository } from 'typeorm';
import { Location, Reservation, Slot } from '@lib/database';
import { CreateSlotDto } from './dto/create-slot.dto';
import { ListSlotsDto } from './dto/list-slots.dto';

export interface SlotWithAvailability extends Slot {
  available: number;
}

/**
 * Admin/browse operations for slots, distinct from `SlotHoldService`'s
 * claim/confirm/release lifecycle. Creating a slot here only writes the
 * Postgres row -- it deliberately doesn't touch Redis, since
 * `slot:{slotId}:available` is lazily seeded from Postgres on first claim
 * (see `SlotHoldService`).
 */
@Injectable()
export class SlotAdminService {
  constructor(
    @InjectRepository(Slot) private readonly slots: Repository<Slot>,
    @InjectRepository(Location) private readonly locations: Repository<Location>,
    @InjectRepository(Reservation) private readonly reservations: Repository<Reservation>,
  ) {}

  async create(dto: CreateSlotDto): Promise<Slot> {
    const location = await this.locations.findOne({ where: { id: dto.locationId } });
    if (!location) {
      throw new NotFoundException(`Location ${dto.locationId} not found`);
    }

    const startTime = new Date(dto.startTime);
    const endTime = new Date(dto.endTime);
    if (endTime <= startTime) {
      throw new BadRequestException('endTime must be after startTime');
    }

    return this.slots.save(
      this.slots.create({
        locationId: location.id,
        startTime,
        endTime,
        capacity: dto.capacity,
      }),
    );
  }

  /**
   * `available` is computed against Postgres (capacity minus reservations
   * still consuming a spot -- `held` or `confirmed`), not read from Redis.
   * This is a browse path, not the booking hot path, so it favors the
   * always-consistent source of truth over the cache `SlotHoldService`
   * uses for claim/confirm/release.
   */
  async findMany(query: ListSlotsDto): Promise<SlotWithAvailability[]> {
    const from = query.from ? new Date(query.from) : new Date();
    const where: FindOptionsWhere<Slot> = {
      startTime: query.to ? Between(from, new Date(query.to)) : MoreThanOrEqual(from),
    };
    if (query.locationId) {
      where.locationId = query.locationId;
    }

    const slots = await this.slots.find({ where, order: { startTime: 'ASC' } });
    if (slots.length === 0) {
      return [];
    }

    const activeReservations = await this.reservations.find({
      where: { slotId: In(slots.map((slot) => slot.id)), status: In(['held', 'confirmed']) },
    });
    const bookedBySlot = new Map<string, number>();
    for (const reservation of activeReservations) {
      bookedBySlot.set(reservation.slotId, (bookedBySlot.get(reservation.slotId) ?? 0) + 1);
    }

    return slots.map((slot) => ({
      ...slot,
      available: slot.capacity - (bookedBySlot.get(slot.id) ?? 0),
    }));
  }
}
