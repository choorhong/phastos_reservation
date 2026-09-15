import type { Redis, Result } from 'ioredis';

/**
 * The three atomic hold-lifecycle Lua scripts (see PLAN.md §2). Kept as
 * inline template literals rather than separate .lua files read from disk:
 * this app builds with webpack (see nest-cli.json), which bundles imported
 * .ts sources but does not copy arbitrary non-TS assets into `dist` by
 * default, so a runtime `fs.readFileSync` against a sibling .lua file is
 * fragile across build tools (tsc vs. webpack, dev vs. built image). Inlining
 * makes the script content part of the compiled bundle with no extra build
 * step, at the cost of losing standalone .lua syntax highlighting.
 */

// Atomically claim one unit of slot capacity and create a time-boxed hold.
// KEYS[1] = slot:{slotId}:available
// KEYS[2] = hold:{slotId}:{holdId}
// KEYS[3] = slot:{slotId}:pending
// ARGV[1] = holdId, ARGV[2] = userId, ARGV[3] = holdTtlSeconds, ARGV[4] = nowMs
const CLAIM_SCRIPT = `
local available = tonumber(redis.call('GET', KEYS[1]))
if available == nil then
  return redis.error_reply('SLOT_NOT_LOADED')
end
if available <= 0 then
  return redis.error_reply('SOLD_OUT')
end

redis.call('DECR', KEYS[1])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
redis.call('ZADD', KEYS[3], tonumber(ARGV[4]) + (tonumber(ARGV[3]) * 1000), ARGV[1])

return redis.status_reply('HELD')
`;

// Consume a live hold at checkout time. Capacity stays decremented
// permanently; the caller writes the Postgres row of record next.
// KEYS[1] = hold:{slotId}:{holdId}
// KEYS[2] = slot:{slotId}:pending
// ARGV[1] = holdId
const CONFIRM_SCRIPT = `
local userId = redis.call('GET', KEYS[1])
if not userId then
  return redis.error_reply('HOLD_EXPIRED')
end

redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])

return userId
`;

// Return one unit of capacity: explicit cancel, or reaped expiry.
// KEYS[1] = slot:{slotId}:available
// KEYS[2] = hold:{slotId}:{holdId}
// KEYS[3] = slot:{slotId}:pending
// ARGV[1] = holdId
const RELEASE_SCRIPT = `
if redis.call('EXISTS', KEYS[2]) == 1 then
  redis.call('DEL', KEYS[2])
end
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('INCR', KEYS[1])

return redis.status_reply('RELEASED')
`;

declare module 'ioredis' {
  interface RedisCommander<Context> {
    claimSlot(
      availableKey: string,
      holdKey: string,
      pendingKey: string,
      holdId: string,
      userId: string,
      holdTtlSeconds: string | number,
      nowMs: string | number,
    ): Result<'HELD', Context>;

    confirmHold(holdKey: string, pendingKey: string, holdId: string): Result<string, Context>;

    releaseHold(
      availableKey: string,
      holdKey: string,
      pendingKey: string,
      holdId: string,
    ): Result<'RELEASED', Context>;
  }
}

/**
 * Registers the three atomic hold-lifecycle Lua scripts as first-class
 * commands on an ioredis client. Call once per client instance, e.g. in a
 * Nest provider factory for the injectable Redis connection.
 */
export function attachHoldScripts(redis: Redis): Redis {
  redis.defineCommand('claimSlot', { numberOfKeys: 3, lua: CLAIM_SCRIPT });
  redis.defineCommand('confirmHold', { numberOfKeys: 2, lua: CONFIRM_SCRIPT });
  redis.defineCommand('releaseHold', { numberOfKeys: 3, lua: RELEASE_SCRIPT });
  return redis;
}

/**
 * Key builders using the `{slotId}` hash tag so all keys for one slot hash
 * to the same Redis Cluster slot -- required for the Lua scripts above to
 * stay atomic across a clustered deployment.
 */
export function slotKeys(slotId: string) {
  return {
    available: `slot:{${slotId}}:available`,
    pending: `slot:{${slotId}}:pending`,
    hold: (holdId: string) => `hold:{${slotId}}:${holdId}`,
  };
}

/**
 * A single global SET of slotIds that have (or recently had) a live hold.
 * `SlotHoldService.claim` adds to it; the reaper's reconciliation sweep
 * (PLAN.md §2) reads it via `SMEMBERS` to know which per-slot `pending`
 * ZSETs to scan, so the sweep works across app restarts/instances instead
 * of relying on any one process's in-memory state. Intentionally not hash
 * tagged -- it's a plain single-key command (`SADD`/`SMEMBERS`), never
 * combined into the same multi-key Lua call as the per-slot keys above, so
 * it doesn't need to share their Cluster hash slot.
 */
export const ACTIVE_SLOTS_KEY = 'slots:active-holds';
