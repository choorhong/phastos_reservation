# Redis hold flow

This project uses Redis for the fast, atomic slot-hold lifecycle. Redis is a cache of Postgres-derived availability, not the system of record.

## Core keys

- `slot:{slotId}:available`
  - String/integer counter for remaining slot capacity.
  - Checked in the Lua claim script before allowing a new hold.
  - Decremented on claim, incremented on release.

- `slot:{slotId}:pending`
  - Sorted set (ZSET) of pending hold IDs for a slot.
  - Each member is a `holdId` and each score is the expiry timestamp.
  - Used by the reaper to detect expired holds.
  - Eg: `slot:{slot-42}:pending` = { holdA -> 1727000500000, holdB -> 1727000800000 }

- `hold:{slotId}:{holdId}`
  - Actual hold record for a specific hold.
  - Stores the `userId` and has a TTL.
  - Created by the claim script and removed by confirm/release/expiry cleanup.
  - Eg: `SET hold:{slot-42}:3f1e... user-99 EX 300`

- `slots:active-holds`
  - Global set of slot IDs that currently have or recently had active holds.
  - Used by the reaper sweep to know which slot-level pending ZSETs to scan.
  - Eg: `slots:active-holds` = { slot-42, slot-99, slot-100 }
  - Then for each slot, redis checks for: `slot:{slot-42}:pending`, `slot:{slot-99}:pending`

## Claim flow

The atomic claim logic is in `libs/redis-scripts/src/redis-hold.scripts.ts`.

The claim script does this in one Redis call:

- read `slot:{slotId}:available`
- reject if missing (`SLOT_NOT_LOADED`)
- reject if zero or negative (`SOLD_OUT`)
- decrement available
- set `hold:{slotId}:{holdId}` with TTL and `userId`
- add `holdId` to `slot:{slotId}:pending` with expiry score

This is done through the `claimSlot` command attached to the Redis client.

## Confirm flow

The confirm script does this:

- read `hold:{slotId}:{holdId}`
- fail if it is gone (`HOLD_EXPIRED`)
- delete the hold key
- remove the hold ID from `slot:{slotId}:pending`

So the hold is consumed at checkout time, and capacity remains decremented permanently.

## Release flow

The release script does this:

- delete `hold:{slotId}:{holdId}` if it still exists
- remove the hold ID from `slot:{slotId}:pending`
- increment `slot:{slotId}:available`

This is used for:

- explicit user cancellation
- reaper cleanup after TTL expiry

## Reaper logic

The reaper service subscribes to Redis key expiration notifications and also runs a periodic sweep.

It scans the `pending` ZSET for expired hold IDs and then calls `release` to return capacity to Redis and update the reservation row in Postgres.

## Important point

Redis holds are transient, fast-moving state. The durable truth is still Postgres.

- Postgres stores the slot definition and reservation records.
- Redis stores the current availability counter and active hold metadata for quick atomic operations.
