import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Logger } from 'nestjs-pino';
import type { Redis } from 'ioredis';
import { Repository } from 'typeorm';
import { ACTIVE_SLOTS_KEY, slotKeys } from '@lib/redis-scripts';
import { Reservation, Slot } from '@lib/database';
import { REDIS_CLIENT } from '@app/api/modules/redis/redis-client.provider';
import { HoldExpiredError, SlotNotLoadedError, SlotSoldOutError } from './slot-hold.errors';

export interface SlotHold {
  holdId: string;
  slotId: string;
  userId: string;
  expiresAt: Date;
}

/**
 * Claim/confirm/release lifecycle for a slot hold, backed by the three
 * atomic Lua scripts in `@lib/redis-scripts` (PLAN.md §2). Redis is a cache
 * of Postgres-derived availability, not the source of truth: on a cache
 * miss (`SlotNotLoadedError` from the script) this service recomputes
 * `capacity - COUNT(confirmed)` from Postgres and seeds the cache with
 * `SETNX` before retrying, exactly once.
 */
@Injectable()
export class SlotHoldService {
  private readonly holdTtlSeconds: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectRepository(Slot) private readonly slots: Repository<Slot>,
    @InjectRepository(Reservation) private readonly reservations: Repository<Reservation>,
    private readonly config: ConfigService,
    private readonly logger: Logger,
  ) {
    this.holdTtlSeconds = this.config.get<number>('HOLD_TTL_SECONDS', 300);
  }

  async claim(slotId: string, userId: string): Promise<SlotHold> {
    const holdId = randomUUID();
    const keys = slotKeys(slotId);
    const nowMs = Date.now();

    try {
      return await this.claimAndRegister(keys, slotId, holdId, userId, nowMs);
    } catch (err) {
      if (!isReplyError(err, 'SLOT_NOT_LOADED')) {
        throw mapClaimError(err, slotId);
      }
    }

    // Cache miss: reload availability from Postgres and retry once.
    await this.loadAvailabilityFromPostgres(slotId);
    try {
      return await this.claimAndRegister(keys, slotId, holdId, userId, nowMs);
    } catch (err) {
      throw mapClaimError(err, slotId);
    }
  }

  private async claimAndRegister(
    keys: ReturnType<typeof slotKeys>,
    slotId: string,
    holdId: string,
    userId: string,
    nowMs: number,
  ): Promise<SlotHold> {
    const hold = await this.runClaim(keys, slotId, holdId, userId, nowMs);
    // Best-effort: lets the reaper's reconciliation sweep discover this
    // slot's `pending` ZSET even if it never received a keyspace
    // notification for it. Not required for the claim itself to be
    // correct/atomic -- see ACTIVE_SLOTS_KEY doc comment.
    await this.redis.sadd(ACTIVE_SLOTS_KEY, slotId);
    return hold;
  }

  async confirm(slotId: string, holdId: string): Promise<string> {
    const keys = slotKeys(slotId);
    try {
      const userId = await this.redis.confirmHold(keys.hold(holdId), keys.pending, holdId);
      return userId;
    } catch (err) {
      if (isReplyError(err, 'HOLD_EXPIRED')) {
        throw new HoldExpiredError(slotId, holdId);
      }
      throw err;
    }
  }

  async release(slotId: string, holdId: string): Promise<void> {
    const keys = slotKeys(slotId);
    await this.redis.releaseHold(keys.available, keys.hold(holdId), keys.pending, holdId);
  }

  private async runClaim(
    keys: ReturnType<typeof slotKeys>,
    slotId: string,
    holdId: string,
    userId: string,
    nowMs: number,
  ): Promise<SlotHold> {
    await this.redis.claimSlot(
      keys.available,
      keys.hold(holdId),
      keys.pending,
      holdId,
      userId,
      this.holdTtlSeconds,
      nowMs,
    );
    return {
      holdId,
      slotId,
      userId,
      expiresAt: new Date(nowMs + this.holdTtlSeconds * 1000),
    };
  }

  /**
   * Seeds `slot:{slotId}:available` from Postgres truth
   * (`capacity - COUNT(confirmed)`) using `SETNX`, so a concurrent cache-miss
   * reload from another request can't clobber a value another request just
   * seeded (or already claimed against).
   */
  private async loadAvailabilityFromPostgres(slotId: string): Promise<void> {
    const slot = await this.slots.findOneOrFail({ where: { id: slotId } });
    const confirmedCount = await this.reservations.count({
      where: { slotId, status: 'confirmed' },
    });
    const available = Math.max(slot.capacity - confirmedCount, 0);

    const keys = slotKeys(slotId);
    const wasSet = await this.redis.setnx(keys.available, available);
    this.logger.log(
      { slotId, capacity: slot.capacity, confirmedCount, available, wasSet: wasSet === 1 },
      'slot.availability.loaded_from_postgres',
    );
  }
}

function isReplyError(err: unknown, code: string): boolean {
  return err instanceof Error && err.message.includes(code);
}

function mapClaimError(err: unknown, slotId: string): Error {
  if (isReplyError(err, 'SOLD_OUT')) {
    return new SlotSoldOutError(slotId);
  }
  if (isReplyError(err, 'SLOT_NOT_LOADED')) {
    return new SlotNotLoadedError(slotId);
  }
  return err as Error;
}
