import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Logger } from 'nestjs-pino';
import type { Redis } from 'ioredis';
import { AppConfigService } from '@lib/config';
import { ACTIVE_SLOTS_KEY } from '@lib/redis-scripts';
import { REDIS_CLIENT, REDIS_SUBSCRIBER_CLIENT } from '@app/api/modules/redis/redis-client.provider';

const EXPIRED_HOLD_PATTERN = /^hold:\{([^}]+)\}:(.+)$/;
const SWEEP_INTERVAL_NAME = 'slot-hold-reaper-sweep';

/**
 * Returns capacity from expired-but-unconfirmed holds (PLAN.md §2). Two
 * layers, because relying on only one is fragile:
 *
 * 1. Keyspace notifications (fast path, near-real-time) -- subscribes to
 *    `__keyevent@*__:expired` and reacts as Redis expires `hold:{slotId}:
 *    {holdId}` keys on their own TTL.
 * 2. A periodic reconciliation sweep (correctness backstop, interval from
 *    HOLD_REAPER_SWEEP_INTERVAL_MS) -- for every slotId in the global
 *    `ACTIVE_SLOTS_KEY` set, scans that slot's `pending` ZSET for holdIds
 *    already past their expiry score whose `hold:*` key no longer exists,
 *    and reaps those too. Catches notifications missed across a Redis
 *    restart/failover window.
 *
 * `releaseHold` is safe to call twice for the same holdId: after the first
 * call the holdId is gone from `pending`, so a second sweep/notification
 * racing on the same expiry won't find it and won't double-increment
 * `available`.
 */
@Injectable()
export class HoldReaperService implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(REDIS_SUBSCRIBER_CLIENT) private readonly subscriber: Redis,
    private readonly config: AppConfigService,
    private readonly scheduler: SchedulerRegistry,
    private readonly logger: Logger,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.subscriber.psubscribe('__keyevent@*__:expired');
    this.subscriber.on('pmessage', (_pattern: string, _channel: string, expiredKey: string) => {
      void this.reapExpiredKey(expiredKey);
    });

    const sweepIntervalMs = this.config.get('HOLD_REAPER_SWEEP_INTERVAL_MS');
    const handle = setInterval(() => void this.sweep(), sweepIntervalMs);
    this.scheduler.addInterval(SWEEP_INTERVAL_NAME, handle);
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscriber.punsubscribe('__keyevent@*__:expired');
    if (this.scheduler.doesExist('interval', SWEEP_INTERVAL_NAME)) {
      this.scheduler.deleteInterval(SWEEP_INTERVAL_NAME);
    }
  }

  private async reapExpiredKey(expiredKey: string): Promise<void> {
    const match = EXPIRED_HOLD_PATTERN.exec(expiredKey);
    if (!match) {
      return; // not a hold key -- ignore (other keys may also carry a TTL)
    }
    const [, slotId, holdId] = match;
    await this.release(slotId, holdId, 'notification');
  }

  private async sweep(): Promise<void> {
    const slotIds = await this.redis.smembers(ACTIVE_SLOTS_KEY);
    for (const slotId of slotIds) {
      await this.sweepSlot(slotId);
    }
  }

  private async sweepSlot(slotId: string): Promise<void> {
    const pendingKey = `slot:{${slotId}}:pending`;
    const expiredHoldIds = await this.redis.zrangebyscore(pendingKey, '-inf', Date.now());
    for (const holdId of expiredHoldIds) {
      const holdKey = `hold:{${slotId}}:${holdId}`;
      const stillLive = await this.redis.exists(holdKey);
      if (stillLive === 0) {
        await this.release(slotId, holdId, 'sweep');
      }
    }
  }

  private async release(
    slotId: string,
    holdId: string,
    reapedBy: 'notification' | 'sweep',
  ): Promise<void> {
    const availableKey = `slot:{${slotId}}:available`;
    const holdKey = `hold:{${slotId}}:${holdId}`;
    const pendingKey = `slot:{${slotId}}:pending`;
    await this.redis.releaseHold(availableKey, holdKey, pendingKey, holdId);
    this.logger.log({ slotId, holdId, reapedBy }, 'slot.hold.expired_reaped');
  }
}
