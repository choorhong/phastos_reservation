/**
 * Maps 1:1 to the `redis.error_reply(...)` strings the Lua scripts in
 * `@lib/redis-scripts` can return (PLAN.md §2). ioredis surfaces those as a
 * `ReplyError` whose `.message` is exactly this string.
 */
export class SlotNotLoadedError extends Error {
  constructor(readonly slotId: string) {
    super(`Slot ${slotId} availability is not cached in Redis (cache miss)`);
    this.name = 'SlotNotLoadedError';
  }
}

export class SlotSoldOutError extends Error {
  constructor(readonly slotId: string) {
    super(`Slot ${slotId} has no remaining capacity`);
    this.name = 'SlotSoldOutError';
  }
}

export class HoldExpiredError extends Error {
  constructor(
    readonly slotId: string,
    readonly holdId: string,
  ) {
    super(`Hold ${holdId} for slot ${slotId} has already expired or was released`);
    this.name = 'HoldExpiredError';
  }
}
