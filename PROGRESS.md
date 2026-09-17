# Progress Log

Tracks what's actually been built, in what order, so this can be picked back
up without re-deriving context. See `PLAN.md` for the architecture/design —
this file is just the build log against that plan.

---

## Status: paused after wiring HTTP reservation endpoints

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

## Step 5 — Kafka ✅

- `docker-compose.yml`: added `kafka` (`confluentinc/cp-kafka:7.6.0`, KRaft
  mode, no Zookeeper) + `kafka-ui` (`provectuslabs/kafka-ui`, port 8080) per
  PLAN.md §5. Healthcheck via `kafka-broker-api-versions`.
- `.env.example` / `.env`: added `KAFKA_BROKERS`, `KAFKA_CLIENT_ID`,
  `KAFKA_TOPIC_REPLICATION_FACTOR` (1 locally, 3 in PLAN.md's non-local
  guidance), `EVENT_CONSUMER_GROUP_ID`.
- `libs/database`: new `ProcessedEvent` entity (`processed_events`,
  composite PK `(event_id, consumer_name)` -- PLAN.md §3's
  idempotent-consumption ledger; composite rather than `event_id` alone so
  multiple downstream consumers can dedupe independently against the same
  event) + migration `AddProcessedEvents`. Added to `DatabaseModule`'s
  `entities`/`forFeature` and `data-source.ts`.
- `libs/kafka-contracts/src/reservation-events.ts` (envelope + payload
  types already existed from Step 1; added the runtime pieces):
  - `ensureReservationEventsTopic(admin, replicationFactor)` -- idempotent
    topic creation (`partitions: 12` per PLAN.md §3), run by both apps on
    startup, same "whichever comes up first wins" pattern as
    `assertNotificationsTopology`.
  - `publishReservationEvent(producer, eventType, {slotId, locationId,
    correlationId, payload})` -- envelopes + sends, keyed by `slotId` so a
    slot's events land in one partition and stay ordered. Shared so the
    envelope shape can't drift between producers.
- `apps/api/src/modules/kafka/` -- `KAFKA_PRODUCER` provider: connects,
  ensures the topic via an `Admin` client, then returns a connected
  `Producer`.
- `apps/api/src/modules/events/events-publisher.service.ts` --
  `EventsPublisherService.publishReservationRequested/Confirmed/Cancelled` +
  `publishSlotReleased`, thin wrappers over `publishReservationEvent`. Same
  caveat as `NotificationsPublisherService`: not called from anywhere yet,
  ready for the HTTP reservation flow.
- `apps/event-consumer/src/modules/kafka/` -- `KAFKA_CONSUMER` provider:
  connects, ensures the topic, subscribes to `reservation-events`.
- `apps/event-consumer/src/modules/events/events-consumer.service.ts` --
  `EventsConsumerService` stands in for analytics/audit/inventory-sync at
  once (same scope boundary as the notification handlers -- logs, no real
  downstream integration yet). Claims each event with a raw
  `INSERT INTO processed_events ... ON CONFLICT DO NOTHING RETURNING
  event_id` *before* "processing" it; an empty `RETURNING` result means a
  duplicate delivery, logged and skipped.
- `AppModule` (api, event-consumer): wired in `KafkaModule`/`EventsModule`,
  and (`event-consumer` only) `DatabaseModule` for the `processed_events`
  ledger.

### Verified (ad hoc scripts, not committed)

Ran via `npx ts-node -r tsconfig-paths/register <script>.ts` against real
Postgres + Kafka containers, with `api` and `event-consumer` built and
running:

- Both apps' boot logs confirmed topic auto-creation with all 12
  partitions (`event-consumer`'s consumer-group join showed
  `memberAssignment: {"reservation-events":[0,1,...,11]}`).
- Published a `ReservationRequested` event via `EventsPublisherService` →
  `event-consumer` logged `reservation_event.processed`.
- **Caught and fixed a real bug during verification**: the first cut of
  the dedupe check used TypeORM's query-builder `.insert().orIgnore()` and
  checked `result.identifiers.length`. Since `ProcessedEvent`'s primary key
  columns aren't DB-generated, TypeORM populates `identifiers` from the
  *input* values regardless of whether Postgres actually inserted the row
  or discarded it via `ON CONFLICT DO NOTHING` -- so a redelivered event
  with the same `eventId` was logged as freshly processed a second time,
  even though Postgres correctly kept only one `processed_events` row.
  Fixed by switching to a raw parameterized query with
  `ON CONFLICT DO NOTHING RETURNING event_id` and checking whether any row
  came back. Re-verified: republishing the same `eventId` now logs
  `reservation_event.duplicate_skipped`, and `processed_events` stayed at
  exactly one row throughout.

All test rows cleaned up afterward (`DELETE FROM processed_events`).

### Current environment state (as of pausing)

- `phastos-kafka` container: **running**, healthy, port 9092. `phastos-kafka-ui`
  running on port 8080 (topic/partition/consumer-lag inspection).
- `phastos-postgres`, `phastos-redis`, `phastos-rabbitmq`: unchanged, still
  running/healthy.
- Migration `AddProcessedEvents1789465789679` applied to the running
  Postgres instance.
- The `reservation-events` topic exists on the broker (12 partitions,
  replication factor 1) from the verification run above.
- No HTTP endpoints call `EventsPublisherService` yet -- same caveat as
  `SlotHoldService` (Step 3) and `NotificationsPublisherService` (Step 4).
  All four infrastructure legs (Redis, Postgres, RabbitMQ, Kafka) are now
  built and independently verified; none of them are reachable over HTTP
  yet. That's the next and last step.

## Step 6 — HTTP reservation endpoints ✅

- Added `class-validator`/`class-transformer`; `main.ts` now installs a
  global `ValidationPipe({ whitelist: true, transform: true })`.
- `apps/api/src/modules/reservations/` — new module tying together all
  four infra legs per PLAN.md §4's direct-vs-queue split:
  - `dto/create-reservation.dto.ts` (`slotId` UUID, `userId` string),
    `dto/cancel-reservation.dto.ts` (optional `reason`, restricted to the
    two user-facing `ReservationCancelReason` values — `hold_expired` is
    system-set (by the reaper), not client-settable).
  - `reservations.service.ts`:
    - `requestHold` — validates the slot exists (clean 404 instead of
      letting `SlotHoldService`'s internal `findOneOrFail` throw),
      `SlotHoldService.claim` (`SlotSoldOutError` → 409), inserts the
      `Reservation` row (`status: held`), then
      `EventsPublisherService.publishReservationRequested`.
    - `confirm` — idempotent if already `confirmed` (returns as-is);
      409 if in any other non-`held` state; `SlotHoldService.confirm`
      (`HoldExpiredError` → marks the row `expired` and returns 410 Gone);
      on success updates to `confirmed`, then
      `publishReservationConfirmed` (Kafka) +
      `publishConfirmationEmail`/`publishReceipt` (RabbitMQ).
    - `cancel` — idempotent if already `cancelled`; 409 if `expired`;
      works uniformly for both `held` and `confirmed` reservations by
      always calling `SlotHoldService.release` — see the important note
      below on why this is correct for both cases; updates to
      `cancelled`, then `publishReservationCancelled` +
      `publishSlotReleased`.
    - Kafka/RabbitMQ publish failures after the Postgres write are caught
      and logged (`*_publish_failed`), never surfaced as an error response
      — a booking that's durably committed to Postgres must not look
      failed to the client just because a downstream event/notification
      publish blipped.
  - `reservations.controller.ts` — `POST /reservations`,
    `POST /reservations/:id/confirm`, `POST /reservations/:id/cancel`
    (`ParseUUIDPipe` on `:id`).
  - Correlation ID for every publish comes from `ClsService.getId()` (the
    CLS-generated/propagated request ID from `ObservabilityModule`) — note
    this is `getId()`, not `cls.get('correlationId')` as that module's own
    doc comment says; the `idGenerator` option only populates the CLS ID
    slot, not a `'correlationId'` key, so `get('correlationId')` would
    always return `undefined`. Left the existing comment as-is (out of
    scope for this step) but don't copy that pattern into new code.
- **Important, easy-to-get-wrong behavior**: `cancel` calls
  `SlotHoldService.release` unconditionally, for both `held` and
  `confirmed` reservations, and this is correct rather than a bug: the
  Redis `RELEASE_SCRIPT` (`libs/redis-scripts`) always does `INCR` on
  `slot:{slotId}:available` regardless of whether the hold key still
  exists. For a `held` reservation this is the normal "return the pending
  unit" path. For a `confirmed` one, the hold key is already gone (confirm
  deleted it) so the `DEL`/`ZREM` lines are no-ops, but the `INCR` still
  fires — which is exactly what should happen, since cancelling a
  confirmed booking must free that slot's capacity back to the pool for
  other users. Verified explicitly (see below).
- `AppModule`: added `ReservationsModule`.

### Verified (ad hoc curl + raw Kafka/RabbitMQ checks against real containers)

Built and ran `api`, `notification-worker`, `event-consumer`
(`node dist/apps/<app>/main.js`) against real Postgres/Redis/RabbitMQ/Kafka,
seeded one capacity-1 location/slot:

- `POST /reservations` (user-A) → `201`, `status: held`.
- `POST /reservations` (user-B, same slot) → `409 SlotSoldOutError` message.
- `POST /reservations/:id/confirm` → `200`, `status: confirmed`; calling it
  again → `200` with the same body (idempotent), no duplicate Kafka event.
- `POST /reservations/:id/cancel` on the now-`confirmed` reservation → `200`,
  `status: cancelled`; `redis-cli GET slot:{slotId}:available` back to `1`;
  a fresh `POST /reservations` (user-C) on the same slot → `201` (capacity
  genuinely freed, not just a Postgres-side status flip).
- `POST /reservations/:id/confirm` on an unknown UUID → `404`;
  `POST /reservations` with an unknown `slotId` → `404`.
- `rabbitmqctl list_queues` showed 1 message each in `q.confirmation-email`
  / `q.receipt` right after confirm; starting `notification-worker` drained
  both with `notification.delivered` log lines.
- Read `reservation-events` partition 0 directly
  (`kafka-console-consumer --partition 0 --offset 0`): all 5 events from
  the run appeared in order with correct payloads —
  `ReservationRequested`(A) → `ReservationConfirmed`(A) →
  `ReservationCancelled`(A) → `SlotReleased` → `ReservationRequested`(C).
  (Starting `event-consumer` fresh showed 0 lag / no `reservation_event.processed`
  logs for this partition — a `kafkajs` consumer-group-first-assignment
  quirk, defaults to latest rather than earliest for a partition the group
  has never committed an offset on before; not a bug in the publish path,
  confirmed by reading the partition directly instead.)

All test rows/messages/keys cleaned up afterward (`DELETE` on seeded
location/slot/reservations, `redis-cli FLUSHDB`, `DELETE FROM
processed_events`).

### Current environment state (as of pausing)

- All four containers (`phastos-postgres`, `phastos-redis`,
  `phastos-rabbitmq`, `phastos-kafka` + `phastos-kafka-ui`) running,
  healthy — brought back up this session after a prior pause (`docker
  compose up -d`; data persisted in the named volumes).
- No `api`/`notification-worker`/`event-consumer` processes left running.
- No payment step, by design — this is a free appointment-booking system
  (Apple Genius Bar-style), not a paid reservation, so there's nothing to
  authorize between hold and confirm. `payment_failed` was removed from
  `ReservationCancelReason` (`libs/domain`) and
  `ReservationCancelledPayload.reason` (`libs/kafka-contracts`), and the
  "Payment authorization" row was dropped from PLAN.md §4's table — it
  never matched what this system actually does.
- No `GET /reservations/:id` (or any read/list endpoint) yet — out of
  scope for this step, which was specifically "wire the write/lifecycle
  endpoints"; add one if a client needs to poll reservation status.

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
3. **Editor-only "File X is not under 'rootDir' Y" errors on cross-lib
   imports** (e.g. opening `apps/api/src/app.module.ts`, which imports
   `@app/common`/`@app/database`) — none of `tsconfig.app.json`/
   `tsconfig.lib.json` ever set `rootDir` explicitly, leaving it to be
   *inferred* from whichever files end up in the compiled program. Plain
   `tsc` and `nest build` (webpack) both infer it correctly (common
   ancestor of every file actually pulled in via `@app/*` path mapping =
   the repo root) — verified by direct emit, output correctly
   nested under `dist/<...>/libs/...`. An editor's live TS-server
   instance, though, can end up inferring a narrower `rootDir` (seen:
   the app's own folder) for a given open file, wrongly flagging any
   cross-lib import as outside it. Fixed by setting `"rootDir": "../.."`
   (the repo root, matching the already-correct `"baseUrl"`) explicitly
   in every `tsconfig.app.json` and `tsconfig.lib.json` — removes the
   inference step entirely rather than trying to fix the inference.
   Confirmed harmless for the real build path: `nest build <app>` uses
   webpack (not raw `tsc` emit), so it still produces a single clean
   `dist/apps/<app>/main.js` regardless of `rootDir` — the "mirrors the
   full rootDir-relative path" behavior from gotcha #1 only ever applies
   to a bypassed, non-webpack `tsc -p ... ` emit, which nothing here uses.
4. **`@/*` retired in favor of `@app/<app>/*`.** The original convention
   (commit `dad167b`) used the *same* alias name `@/*` in every app,
   scoped to that app's own `tsconfig.app.json` (`@/foo` meant "this
   app's own src", identically worded in every app). That meant the
   `@app/*` lib aliases had to be fully re-declared alongside `@/*` in
   every `tsconfig.app.json`/`tsconfig.lib.json` — TypeScript's `extends`
   does not merge a child's `paths` with the base's, it replaces the
   whole map, so any config that added its own alias had to restate every
   inherited one too. Switched to per-app aliases living once in the root
   `tsconfig.json` — `@app/api/*`, `@app/notification-worker/*`,
   `@app/event-consumer/*` (alongside the existing flat `@app/<lib>`
   entries) — so every `tsconfig.app.json` now inherits the full `paths`
   map untouched and needs nothing but `outDir`/`rootDir` of its own.
   Updated all import sites (14 in `apps/api`, 3 in
   `apps/notification-worker`, 2 in `apps/event-consumer`) from
   `@/modules/...` to `@app/<app>/modules/...`. Trade-off accepted
   knowingly: a module's own imports now name the app it lives in, so
   copying a module between apps means updating its imports, unlike the
   old scheme where `@/` read identically everywhere.
5. **Lib aliases split from `@app/*` to `@lib/*`.** Once apps had their own
   `@app/<app>/*` aliases, the existing lib aliases (`@app/domain`,
   `@app/database`, etc.) became ambiguous — `@app/domain` and `@app/api`
   looked structurally identical despite one being a lib and the other an
   app. Renamed every lib alias to `@lib/<lib>` (`@lib/domain`,
   `@lib/database`, `@lib/kafka-contracts`, `@lib/redis-scripts`,
   `@lib/rabbitmq-contracts`, `@lib/common`), so the prefix alone now says
   which kind of thing you're importing: `@app/*` only ever means "an app
   in this monorepo," `@lib/*` only ever means "a shared lib." Updated all
   28 import sites across 22 files (every app + every lib that
   cross-references another lib, e.g. `libs/database`'s entities importing
   `@lib/domain`'s types) plus the six `libs/*/tsconfig.lib.json` doc
   comments that mentioned the old name. Verified via the same three
   checks as gotcha #4 (`tsc --noEmit` on all 9 projects, `nest build` on
   all 3 apps, real boot + `/health` on all 3 apps against live containers)
   plus one this rename specifically touches: `npm run typeorm --
   migration:show` (uses `ts-node -r tsconfig-paths/register`, a separate
   path-resolution mechanism from webpack) still resolves `@lib/domain`
   correctly through `data-source.ts`'s entities.

## Next step: auth/authz (not started)

All four infrastructure legs and the reservation lifecycle HTTP endpoints
(Step 6) are built and verified end-to-end. No payment step is planned —
this is a free appointment-booking system (Apple Genius Bar-style), not a
paid reservation. What's left before this is a real system:

- **Auth/authz**: every endpoint currently trusts a client-supplied
  `userId` with no verification — there's no auth layer at all yet. Fine
  for continued local iteration, not fine beyond that.
- No read/list endpoints (`GET /reservations/:id`, `GET /slots?...` for
  browsing availability) — add if/when a client needs them.
