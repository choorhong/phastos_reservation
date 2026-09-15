# Progress Log

Tracks what's actually been built, in what order, so this can be picked back
up without re-deriving context. See `PLAN.md` for the architecture/design —
this file is just the build log against that plan.

---

## Status: paused after RabbitMQ, before Kafka

## Decisions locked in (see `PLAN.md` "Decisions")

- ORM: **TypeORM**
- Reminder scheduling: **DB scheduler sweep → RabbitMQ** (not the delayed-exchange plugin)
- Observability: **wired in from day 1** (pino + nestjs-cls), not retrofitted

## Step 1 — Base monorepo scaffold ✅

Nest CLI monorepo (`nest-cli.json`, `monorepo: true`), **webpack** builder (not
`tsc`) — needed to avoid `tsc` mirroring the full repo-root-relative path into
`dist` when an app imports sibling `libs/*` sources (hit this, fixed it — see
git history / this file's "Gotchas" section below).

```
apps/api                  # HTTP API, port 3000 — the booking hot path
apps/notification-worker  # RabbitMQ consumers, port 3001 (health-only stub so far)
apps/event-consumer       # Kafka consumers, port 3002 (health-only stub so far)
libs/domain                # plain shared TS types (ReservationStatus, etc.)
libs/kafka-contracts       # reservation-events.ts — full envelope + payload types from PLAN.md §3
libs/redis-scripts         # claim/confirm/release Lua scripts (inlined as TS template literals, not separate .lua files — see Gotchas) + attachHoldScripts()/slotKeys() helpers
libs/database               # TypeORM entities/migrations/DataSource (built out in Step 2)
libs/rabbitmq-contracts    # placeholder — filled in when RabbitMQ step happens
libs/common                # ObservabilityModule: nestjs-pino + nestjs-cls, correlationId from `x-correlation-id` header or generated
```

All three apps build (`npx nest build <api|notification-worker|event-consumer>`)
and boot (`node dist/apps/<app>/main.js`), each serving `GET /health`, each
logging structured JSON via pino.

Git repo initialized (`git init`). **Nothing has been committed yet** —
everything is `git add`-ed (staged) but sitting there uncommitted. Decide
before resuming whether to make an initial commit.

## Step 2 — Postgres ✅

- `docker-compose.yml` created: `postgres:16` service, healthcheck via
  `pg_isready`, named volume `pgdata`.
- `.env.example` added (Postgres host/port/creds + app ports). Copied to
  `.env` locally to run migrations/boot the app (`.env` is gitignored).
- `libs/database`:
  - Entities: `Location`, `Slot` (`capacity: int`), `Reservation`
    (`holdId` is `UNIQUE NOT NULL` — makes a retried Redis-confirm
    idempotent on the Postgres side; `status` is `held | confirmed |
    cancelled | expired`).
  - `DatabaseModule` — `TypeOrmModule.forRootAsync` via `ConfigService`,
    **`synchronize: false` always** (schema only moves through migrations,
    so the trigger below is never silently dropped by a sync).
  - `data-source.ts` — `DataSource` config for the TypeORM CLI.
  - `libs/database/migrations/1789211003000-InitialSchema.ts` — creates all
    three tables, plus **`enforce_slot_capacity`**: a `BEFORE INSERT OR
    UPDATE OF status` trigger on `reservations` that row-locks the slot
    (`SELECT ... FOR UPDATE`) and refuses to let a row become `confirmed`
    if that would exceed the slot's `capacity`. This is the DB-level
    defense-in-depth from `PLAN.md` §2 — it holds even if Redis is
    bypassed, stale, or lost.
- Wired `DatabaseModule` into `apps/api`'s `AppModule`.

### Verified (commands to re-run this verification after resuming)

```bash
docker compose up -d postgres
# wait for healthy:
docker inspect --format='{{.State.Health.Status}}' phastos-postgres

cp .env.example .env   # if not already present
npm run typeorm -- migration:run -d libs/database/src/data-source.ts

# confirm schema:
docker exec phastos-postgres psql -U phastos -d phastos_reservation -c "\dt"

# confirm the capacity trigger actually rejects overbooking:
docker exec -i phastos-postgres psql -U phastos -d phastos_reservation <<'SQL'
BEGIN;
INSERT INTO locations (id, name, address, timezone) VALUES ('11111111-1111-1111-1111-111111111111', 'Test Store', '1 Infinite Loop', 'America/Los_Angeles');
INSERT INTO slots (id, location_id, start_time, end_time, capacity) VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', now(), now() + interval '30 minutes', 1);
INSERT INTO reservations (slot_id, user_id, hold_id, status) VALUES ('22222222-2222-2222-2222-222222222222', 'user-A', 'hold-A', 'confirmed');
INSERT INTO reservations (slot_id, user_id, hold_id, status) VALUES ('22222222-2222-2222-2222-222222222222', 'user-B', 'hold-B', 'confirmed');
ROLLBACK;
SQL
# expect: the second INSERT errors with SLOT_CAPACITY_EXCEEDED

# confirm the api app itself connects:
npx nest build api
node dist/apps/api/main.js &
curl -s localhost:3000/health
# look for "TypeOrmCoreModule dependencies initialized" in the boot log
```

All of the above passed at the time this was written.

### Current environment state (as of pausing)

- `phastos-postgres` container: **running**, healthy, port 5432.
  → Stop with `docker compose stop postgres` if you want to free resources
  while paused; `docker compose up -d postgres` brings it back (data
  persists in the `pgdata` volume either way).
- `.env` exists locally (copied from `.env.example`, gitignored).
- Migration `InitialSchema1789211003000` has been applied to the running
  Postgres instance's `pgdata` volume.

## Step 3 — Redis ✅

- `docker-compose.yml`: added `redis:7-alpine` service, `--notify-keyspace-events Ex`
  (required for the reaper's fast path), named volume `redisdata`, healthcheck via
  `redis-cli ping`.
- `.env.example` / `.env`: added `REDIS_HOST`, `REDIS_PORT`, `HOLD_TTL_SECONDS` (300),
  `HOLD_REAPER_SWEEP_INTERVAL_MS` (30000).
- `libs/redis-scripts`: added `ACTIVE_SLOTS_KEY` (`slots:active-holds`) — a plain
  (non-hash-tagged) global Redis SET of slotIds with a live/recent hold, so the
  reaper's sweep can discover which slots to scan without relying on any one
  process's in-memory state (works across app restarts/instances). Deliberately
  kept out of the atomic Lua scripts, which must stay single-hash-tag for Redis
  Cluster compatibility (PLAN.md §2) — populated instead as a best-effort
  separate `SADD` from `SlotHoldService.claim()`.
- `apps/api/src/modules/redis/`:
  - `redis-client.provider.ts` — two ioredis clients: `REDIS_CLIENT` (general
    commands + the three attached Lua commands via `attachHoldScripts()`) and
    `REDIS_SUBSCRIBER_CLIENT` (dedicated connection for keyspace-notification
    `PSUBSCRIBE` — ioredis can't mix pub/sub mode with ordinary commands on one
    connection).
  - `redis.module.ts` — provides/exports both.
- `apps/api/src/modules/slots/`:
  - `slot-hold.service.ts` — `SlotHoldService.claim/confirm/release`, wrapping
    the Lua scripts. On `SLOT_NOT_LOADED` (cache miss), recomputes
    `capacity - COUNT(confirmed)` from Postgres and seeds
    `slot:{slotId}:available` with `SETNX` before retrying the claim once.
    Lua `error_reply` strings are mapped to typed errors (`slot-hold.errors.ts`:
    `SlotNotLoadedError`, `SlotSoldOutError`, `HoldExpiredError`) by matching on
    `err.message` (ioredis surfaces `redis.error_reply(...)` as a `ReplyError`
    whose message is that exact string).
  - `hold-reaper.service.ts` — `HoldReaperService`, the two-layer reaper from
    PLAN.md §2: `PSUBSCRIBE __keyevent@*__:expired` (fast path) +
    a `SchedulerRegistry`-registered interval reading `ACTIVE_SLOTS_KEY` →
    per-slot `ZRANGEBYSCORE pending -inf now` → reap anything whose `hold:*`
    key is already gone (backstop for notifications missed across a Redis
    restart/failover). Both paths funnel into the same `releaseHold` Lua call
    and log `slot.hold.expired_reaped` with `reapedBy: "notification" | "sweep"`.
  - `slots.module.ts` — wires `SlotHoldService` + `HoldReaperService`, imports
    `RedisModule` and `TypeOrmModule.forFeature([Slot, Reservation])`.
- `AppModule`: added `ScheduleModule.forRoot()` (needed for
  `HoldReaperService`'s `SchedulerRegistry`-based sweep interval) and
  `SlotsModule`.

### Verified (ad hoc scripts, not committed — re-create similarly if re-verifying)

Ran via `npx ts-node -r tsconfig-paths/register <script>.ts`, using
`NestFactory.createApplicationContext(AppModule)` + a seeded capacity-1
Postgres slot:

- Claim on a cold cache → `slot.availability.loaded_from_postgres` log line,
  then `HELD`.
- Second claim on the same (now-exhausted) slot → `SlotSoldOutError`.
- Confirm → returns the holding `userId`; confirming the same `holdId` again
  → `HoldExpiredError` (Postgres-side idempotency via `holdId UNIQUE` is the
  layer below this; this is the Redis-side rejection before it ever reaches
  Postgres).
- Reaper fast path: claimed with `HOLD_TTL_SECONDS=3`, waited past expiry —
  `slot.hold.expired_reaped` with `reapedBy: "notification"`,
  `available` back to 1, `pending` empty, `hold:*` key gone.
- Reaper backstop: same test with `redis-cli config set notify-keyspace-events ""`
  (notifications off) and `HOLD_REAPER_SWEEP_INTERVAL_MS=2000` — same end
  state via `reapedBy: "sweep"` instead. Re-enabled notifications
  (`config set notify-keyspace-events Ex`) afterward.

All test rows/keys cleaned up afterward (`DELETE` on the seeded location/slot
rows, `redis-cli FLUSHDB`).

### Current environment state (as of pausing)

- `phastos-redis` container: **running**, healthy, port 6379, `redisdata`
  volume (currently empty — flushed after verification).
- `phastos-postgres`: unchanged from Step 2, still running/healthy.
- No HTTP endpoints call `SlotHoldService` yet — it's DI-wired into
  `SlotsModule` but nothing in `apps/api` invokes it outside the ad hoc
  verification scripts above. That's the "wire the actual `reservations`
  HTTP endpoints" work still to come (see "After Redis" below).

## Step 4 — RabbitMQ ✅

- `docker-compose.yml`: added `rabbitmq:3-management` (management UI on
  15672), named volume `rabbitmqdata`, healthcheck via
  `rabbitmq-diagnostics check_port_connectivity`.
- `.env.example` / `.env`: added `RABBITMQ_HOST/PORT/USER/PASSWORD`,
  `NOTIFICATION_MAX_RETRIES` (3), `REMINDER_LEAD_MINUTES` (60),
  `REMINDER_SWEEP_INTERVAL_MS` (60000).
- `libs/database`: migration `AddReminderSentAtToReservations` adds
  `reservations.reminder_sent_at` (nullable timestamptz) + a partial index
  `WHERE reminder_sent_at IS NULL`. This is the claim column for the
  reminder sweep below -- `reminderSentAt` added to the `Reservation`
  entity.
- `libs/rabbitmq-contracts/src/notification-messages.ts` (previously an
  empty placeholder):
  - Three queues (`confirmation-email`, `reminder`, `receipt`) per
    PLAN.md §4, one `notifications` direct exchange + one
    `notifications.dlx` DLX, each main queue's `x-dead-letter-exchange`
    pointing at the DLX with its own routing key so a dead-lettered
    message lands in that queue's own `*.dlq`, not a shared one.
  - `assertNotificationsTopology(channel)` -- idempotent
    assert/bind, run by both `apps/api` and `apps/notification-worker` on
    startup so either can come up first.
  - `publishNotification(channel, queue, payload, correlationId)` --
    shared envelope-construction + publish, used by both apps' producer
    code so the message shape/headers can't drift between them (mirrors
    how `attachHoldScripts` centralizes the Redis-side equivalent).
  - `RETRY_COUNT_HEADER` (`x-retry-count`) -- the header the consumer
    reads/increments for the retry-then-DLQ policy.
- `apps/api/src/modules/rabbitmq/` + `apps/notification-worker/src/modules/rabbitmq/`
  (near-identical, kept app-local rather than shared since each app owns
  its own connection lifecycle): `amqp-connection-manager` connection +
  a `ChannelWrapper` whose `setup` runs `assertNotificationsTopology`.
- `apps/api/src/modules/notifications/notifications-publisher.service.ts`
  -- `NotificationsPublisherService.publishConfirmationEmail/publishReminder/publishReceipt`,
  thin wrappers over `publishNotification`. Not called from anywhere yet
  (no HTTP reservation-confirm flow exists) -- it's the integration point
  that flow will use once built.
- `apps/notification-worker/src/modules/notifications/`:
  - `notification-consumers.service.ts` -- `NotificationConsumersService`
    consumes all three queues. No real SendGrid/SES/PDF integration
    (out of scope for this stage) -- the handler validates payload shape
    and logs `notification.delivered`; a malformed payload is the
    realistic failure mode exercised for the retry/DLQ path. On failure:
    retry by republishing with `x-retry-count` incremented (up to
    `NOTIFICATION_MAX_RETRIES`, ack the original), or past that,
    `nack(msg, false, false)` so the queue's own DLX routing takes over
    -- logs `notification.retry_scheduled` / `notification.dead_lettered`.
  - `reminder-sweep.service.ts` -- `ReminderSweepService`, the DB-sweep
    half of "Decisions" #2. A `SchedulerRegistry`-registered interval
    (same pattern as the Redis hold reaper) queries confirmed
    reservations with `reminder_sent_at IS NULL` whose slot starts within
    `REMINDER_LEAD_MINUTES`; for each, does a conditional
    `UPDATE ... WHERE reminder_sent_at IS NULL` (the claim -- guards
    against double-enqueue across overlapping ticks/instances) and only
    publishes to the `reminder` queue if that claim succeeded.
- `AppModule` (both apps): wired in `ScheduleModule.forRoot()` (notification-worker
  needed it fresh; api already had it from the Redis reaper),
  `RabbitmqModule`/`NotificationsModule`, and (`notification-worker` only)
  `DatabaseModule`, since the reminder sweep reads Postgres directly.

### Verified (ad hoc scripts, not committed)

Ran via `npx ts-node -r tsconfig-paths/register <script>.ts` against real
Postgres + RabbitMQ containers, with both `api` and `notification-worker`
built and running (`node dist/apps/<app>/main.js`):

- `rabbitmqctl list_queues` after both apps booted: all 6 queues present
  (3 main + 3 DLQ) with correct `x-dead-letter-exchange`/
  `-routing-key` arguments, each main queue showing 1 active consumer.
- Published a valid `confirmation-email` message via
  `NotificationsPublisherService` (from an `api` application-context
  script) → `notification-worker` logged `notification.delivered` for it.
- Published a malformed message (missing `reservationId`/`userId`)
  directly to `q.confirmation-email` → two `notification.retry_scheduled`
  lines (`retryCount: 1`, `retryCount: 2`), then `notification.dead_lettered`
  → `q.confirmation-email.dlq` held 1 message, main queue 0 (matches
  `NOTIFICATION_MAX_RETRIES=3`: attempts 0/1/2, dead-letter on the 3rd
  failure).
- Reminder sweep: seeded a confirmed reservation with a slot starting in
  30 minutes (`REMINDER_LEAD_MINUTES=60` default), ran
  `notification-worker` with `REMINDER_SWEEP_INTERVAL_MS=2000` for ~5s
  (≥2 sweep ticks) → exactly one `reminder.sweep.enqueued` +
  `notification.delivered` pair (no duplicate across ticks -- confirms
  the `reminder_sent_at` claim guard), and `reservations.reminder_sent_at`
  was set in Postgres.

All test rows/messages cleaned up afterward (`DELETE` on seeded rows,
`rabbitmqctl purge_queue` on the DLQ and `q.reminder`).

### Current environment state (as of pausing)

- `phastos-rabbitmq` container: **running**, healthy, ports 5672 (AMQP) /
  15672 (management UI, `phastos`/`phastos`).
- `phastos-postgres`, `phastos-redis`: unchanged, still running/healthy.
- Migration `AddReminderSentAtToReservations1789463728849` applied to the
  running Postgres instance.
- No HTTP endpoints call `NotificationsPublisherService` yet (same caveat
  as `SlotHoldService` after Step 3) -- confirmation-email/receipt
  publishing is wired and ready but nothing in the request path invokes
  it. The reminder sweep is the one path that's actually live end-to-end
  without an HTTP layer, since it's driven by `notification-worker`'s own
  cron, not a request.

## Gotchas hit and fixed along the way

1. **`webpack: false` in `nest-cli.json` produced nested build output**
   (`dist/apps/api/apps/api/src/main.js`) because `tsc` mirrors the full
   rootDir-relative path when compiling files from sibling `apps/` and
   `libs/` directories together. Fixed by switching to `webpack: true`
   (the standard approach for Nest monorepos with cross-referenced libs) —
   produces a clean single-file bundle at `dist/apps/<app>/main.js`.
2. **Reading `.lua` files via `fs.readFileSync(__dirname, ...)` at runtime
   doesn't survive a webpack bundle** (webpack doesn't copy arbitrary
   non-TS assets into `dist` by default). Fixed by inlining the three Lua
   scripts as TS template literal constants directly in
   `libs/redis-scripts/src/redis-hold.scripts.ts` instead of separate
   `.lua` files — single source of truth, no build-step dependency.

## Next step: Kafka (not started)

Per `PLAN.md` §3: single `reservation-events` topic, partitioned by
`slotId`, 4 event types (`ReservationRequested/Confirmed/Cancelled`,
`SlotReleased`) in one envelope shape, consumed by `event-consumer`
(currently a health-only stub, port 3002). `libs/kafka-contracts` already
has the full envelope + payload types from PLAN.md written (Step 1) — this
step is mostly `docker-compose.yml` (`kafka` in KRaft mode + `kafka-ui` for
inspection, both in PLAN.md §5), a producer wired into `apps/api`, and
`event-consumer`'s actual consumer group + the idempotent-consumption
pattern (`processed_events` table or Redis `SETNX`, PLAN.md §3).

## After Kafka

Per `PLAN.md`: wiring the actual `reservations` HTTP endpoints in
`apps/api` that tie Redis (`SlotHoldService`) + Postgres + Kafka publish +
RabbitMQ enqueue (`NotificationsPublisherService`) together end to end —
everything built in Steps 2-4 is ready and waiting for this; it's the
first point where any of it is reachable over HTTP.
