import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import type { Redis } from 'ioredis';
import {
  And,
  Between,
  FindOperator,
  FindOptionsWhere,
  In,
  LessThan,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import { AppConfigService } from '@lib/config';
import { Location, Reservation, Slot } from '@lib/database';
import { slotKeys } from '@lib/redis-scripts';
import { localDayRange, toSlotLocalTimes } from '@lib/time';
import { REDIS_CLIENT } from '@app/api/modules/redis/redis-client.provider';
import { ListSlotsDto } from './dto/list-slots.dto';

/**
 * A class rather than a plain interface so it also works as an OpenAPI
 * response schema -- `findMany` below still returns plain object literals,
 * never constructed instances, so this has no effect on the actual runtime
 * value. `Slot`'s own fields are inherited; the local-time fields are
 * redeclared rather than also extending `SlotLocalTimes` since TypeScript
 * classes can only extend one class.
 */
export class SlotWithAvailability extends Slot {
  @ApiProperty()
  available: number;

  @ApiProperty()
  timezone: string;

  @ApiProperty()
  localDate: string;

  @ApiProperty()
  localStartTime: string;

  @ApiProperty()
  localEndTime: string;
}

/**
 * Admin/browse operations for slots, distinct from `SlotHoldService`'s
 * claim/confirm/release lifecycle. Slots are created by
 * `SlotGeneratorService`, not by admins; the one admin write is adjusting a
 * slot's capacity (mainly `0` to close it).
 */
@Injectable()
export class SlotAdminService {
  constructor(
    @InjectRepository(Slot) private readonly slots: Repository<Slot>,
    @InjectRepository(Location) private readonly locations: Repository<Location>,
    @InjectRepository(Reservation) private readonly reservations: Repository<Reservation>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Capacity can't exceed the global `SLOT_CAPACITY` or drop below the
   * reservations already consuming a spot (`held` or `confirmed`). The slot
   * row is locked for the check-and-write, the same lock the
   * `enforce_slot_capacity` trigger takes on confirm.
   */
  async updateCapacity(slotId: string, capacity: number): Promise<Slot> {
    const maxCapacity = this.config.get('SLOT_CAPACITY');
    if (capacity > maxCapacity) {
      throw new BadRequestException(`capacity cannot exceed ${maxCapacity}`);
    }

    const { slot, previousCapacity } = await this.slots.manager.transaction(async (manager) => {
      const locked = await manager.findOne(Slot, {
        where: { id: slotId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked) {
        throw new NotFoundException(`Slot ${slotId} not found`);
      }
      const active = await manager.count(Reservation, {
        where: { slotId, status: In(['held', 'confirmed']) },
      });
      if (capacity < active) {
        throw new ConflictException(
          `Slot has ${active} active reservation(s); capacity cannot go below that`,
        );
      }
      const previous = locked.capacity;
      locked.capacity = capacity;
      return { slot: await manager.save(locked), previousCapacity: previous };
    });

    await this.adjustCachedAvailability(slotId, capacity - previousCapacity);
    return slot;
  }

  /**
   * `slot:{slotId}:available` is seeded from Postgres on first claim and is
   * not otherwise re-derived, so a capacity change has to be applied to it
   * too -- only if the key already exists (an unseeded slot will read the new
   * capacity when it is seeded). A claim that seeds the key between the
   * commit above and this call can see the delta applied twice; the
   * `enforce_slot_capacity` trigger still prevents overbooking in that case.
   */
  private async adjustCachedAvailability(slotId: string, delta: number): Promise<void> {
    if (delta === 0) {
      return;
    }
    await this.redis.eval(
      `if redis.call('EXISTS', KEYS[1]) == 1 then return redis.call('INCRBY', KEYS[1], ARGV[1]) end return nil`,
      1,
      slotKeys(slotId).available,
      delta,
    );
  }

  /**
   * `available` is computed against Postgres (capacity minus reservations
   * still consuming a spot -- `held` or `confirmed`), not read from Redis.
   * This is a browse path, not the booking hot path, so it favors the
   * always-consistent source of truth over the cache `SlotHoldService`
   * uses for claim/confirm/release.
   *
   * Each slot also carries its location's timezone and the slot's local
   * date/times in it (see `toSlotLocalTimes`), so clients don't have to do
   * the UTC conversion -- or get it wrong for a viewer in another timezone.
   */
  async findMany(query: ListSlotsDto): Promise<SlotWithAvailability[]> {
    const where: FindOptionsWhere<Slot> = { startTime: await this.startTimeFilter(query) };
    if (query.locationId) {
      where.locationId = query.locationId;
    }

    const slots = await this.slots.find({ where, order: { startTime: 'ASC' } });
    if (slots.length === 0) {
      return [];
    }

    const [activeReservations, locations] = await Promise.all([
      this.reservations.find({
        where: { slotId: In(slots.map((slot) => slot.id)), status: In(['held', 'confirmed']) },
      }),
      this.locations.find({
        where: { id: In([...new Set(slots.map((slot) => slot.locationId))]) },
      }),
    ]);
    const bookedBySlot = new Map<string, number>();
    for (const reservation of activeReservations) {
      bookedBySlot.set(reservation.slotId, (bookedBySlot.get(reservation.slotId) ?? 0) + 1);
    }
    const timezoneByLocation = new Map(
      locations.map((location) => [location.id, location.timezone]),
    );

    return slots.map((slot) => ({
      ...slot,
      available: slot.capacity - (bookedBySlot.get(slot.id) ?? 0),
      ...toSlotLocalTimes(timezoneByLocation.get(slot.locationId)!, slot.startTime, slot.endTime),
    }));
  }

  private async startTimeFilter(query: ListSlotsDto): Promise<FindOperator<Date>> {
    const now = new Date();
    if (!query.date) {
      const from = query.from ? new Date(query.from) : now;
      return query.to ? Between(from, new Date(query.to)) : MoreThanOrEqual(from);
    }

    if (!query.locationId) {
      throw new BadRequestException('date requires locationId');
    }
    if (query.from || query.to) {
      throw new BadRequestException('date cannot be combined with from/to');
    }
    const location = await this.locations.findOne({ where: { id: query.locationId } });
    if (!location) {
      throw new NotFoundException(`Location ${query.locationId} not found`);
    }
    const day = localDayRange(query.date, location.timezone);
    if (!day) {
      throw new BadRequestException('date must be a real calendar date, YYYY-MM-DD');
    }
    // Still floored at now: past slots aren't bookable, so today's already-started ones stay out.
    const from = day.start > now ? day.start : now;
    return And(MoreThanOrEqual(from), LessThan(day.end));
  }
}
