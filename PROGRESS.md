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
event_id` _before_ "processing" it; an empty `RETURNING` result means a
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
  _input_ values regardless of whether Postgres actually inserted the row
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

## Step 7 — Admin endpoints for locations/slots ✅

- `apps/api/src/modules/locations/` — new module: `POST /locations`
  (`name`, `address`, `timezone` — `timezone` validated with
  class-validator's `@IsTimeZone()`, an IANA-zone check, catching typos
  like `Not/AZone` at the DTO layer instead of surfacing a confusing
  downstream error the first time something formats a date with it).
  `LocationsService` is a thin save-and-return over the `Location` repo.
- `apps/api/src/modules/slots/` (existing module, previously only the
  Redis hold lifecycle) — added `SlotAdminService` + `SlotsController`:
  `POST /slots` (`locationId`, `startTime`, `endTime` as ISO date
  strings, `capacity` as a positive int). Validates the location exists
  (404 if not) and `endTime > startTime` (400 if not) before inserting.
  Kept as a separate service/file from `SlotHoldService` (admin CRUD vs.
  claim/confirm/release are different concerns) but the same module,
  since both own the `Slot` entity in `apps/api`. Added `Location` to
  the module's `TypeOrmModule.forFeature`.
- Deliberately does **not** touch Redis on slot creation — availability
  is lazily seeded into `slot:{slotId}:available` from Postgres on the
  first claim (`SlotHoldService.claim`'s `SLOT_NOT_LOADED` path, Step 3),
  so a freshly admin-created slot is immediately bookable with no extra
  wiring. Verified explicitly (see below).
- `AppModule`: added `LocationsModule`.
- No `GET` endpoints yet (listing/browsing locations or slots) — out of
  scope for this step, which was specifically the admin *create* paths.
  Still no auth — these endpoints are as open as the reservation ones.

### Verified (ad hoc curl against real containers)

Built and ran `api` (`node dist/apps/api/main.js`) against the existing
Postgres/Redis containers:

- `POST /locations` with a valid body → `201`, full row back with
  generated `id`.
- `POST /locations` with `timezone: "Not/AZone"` → `400`
  (`@IsTimeZone()` rejects it before it ever reaches Postgres).
- `POST /slots` referencing that location, `capacity: 2` → `201`.
- `POST /slots` with an unknown `locationId` → `404`.
- `POST /slots` with `endTime` before `startTime` → `400`.
- `POST /reservations` against the newly created slot (no manual Redis
  seeding) → `201`, `status: held` — confirms the lazy Postgres→Redis
  load path picks up admin-created slots with no extra step.

All test rows/keys cleaned up afterward (`DELETE` on the seeded
location/slot/reservation rows, `redis-cli FLUSHDB`).

### Current environment state (as of pausing)

- All containers unchanged, still running/healthy.
- No `api` process left running.

## Step 8 — GET endpoints for locations/slots ✅

- `apps/api/src/modules/locations/`: `GET /locations` — lists all
  locations, ordered by `name`. No pagination/filtering (small,
  admin-managed set; add if it ever grows past that).
- `apps/api/src/modules/slots/`: `GET /slots?locationId=&from=&to=` —
  `ListSlotsDto` (all three params optional; `locationId` UUID,
  `from`/`to` ISO date strings). `from` defaults to now (past slots
  aren't bookable, so don't return them by default); `to` is an open
  upper bound if omitted.
  - `SlotAdminService.findMany` — queries `slots` with the
    locationId/startTime filters via the repository's `.find()` (not
    raw QueryBuilder, matching this codebase's existing style — see
    `reminder-sweep.service.ts`), then a second `.find()` for `held`/
    `confirmed` reservations on the matched slot ids, grouped in JS into
    a `Map<slotId, count>`. Each returned slot gets an `available:
    capacity - bookedCount` field.
  - Deliberately reads availability from Postgres, not Redis
    (`slot:{slotId}:available`): this is a browse path, not the booking
    hot path, so it favors the always-consistent source of truth over
    `SlotHoldService`'s cache, and avoids adding a Redis round-trip per
    browsed slot.
  - `available` counts `held` reservations as consumed capacity too
    (not just `confirmed`) since an in-flight hold really is occupying
    that spot from another user's perspective — matches how the Redis
    counter and the Postgres capacity trigger both treat it elsewhere in
    the system.

### Verified (ad hoc curl against real containers)

Built and ran `api` against the existing containers:

- `GET /locations` on an empty table → `[]`; after creating two
  locations → both returned, alphabetically by name.
- Seeded one past slot + two future slots at location A, one future slot
  at location B. `GET /slots` (no filters) → only the 3 future slots,
  past one excluded, each with `available` equal to its `capacity`
  (nothing booked yet).
- `GET /slots?locationId=<A>` → only location A's 2 future slots.
- Booked the capacity-1 slot at location A (`POST /reservations`) →
  re-ran `GET /slots?locationId=<A>` → that slot's `available` dropped
  to `0`, the other slot's `available` unchanged.
- `GET /slots?locationId=not-a-uuid` → `400` (DTO validation on a query
  param, not just body).

All test rows/keys cleaned up afterward (`DELETE` on seeded
location/slot/reservation rows, `redis-cli FLUSHDB`).

### Current environment state (as of pausing)

- All containers unchanged, still running/healthy.
- No `api` process left running.

## Step 9 — Auth/authz (JWT, two roles) ✅

Decisions locked in with the user before building: **JWT bearer tokens**
(not sessions/API keys) and **two roles, `user`/`admin`** (not a single
"authenticated" tier) — admins manage locations/slots, users own their
own reservations.

- `libs/domain`: added `UserRole = 'user' | 'admin'`.
- `libs/database`: new `User` entity (`email` unique, `password_hash`,
  `role`) + migration `AddUsers1789798628495` (`role` also `CHECK`-
  constrained in Postgres, not just application code). Wired into
  `data-source.ts` and `DatabaseModule` alongside the other four
  entities.
- New deps: `@nestjs/jwt`, `bcryptjs` (+ `@types/bcryptjs`) — picked
  `bcryptjs` over `bcrypt` to avoid a native addon in the webpack-bundled
  build (this repo already hit one webpack/native-asset gotcha with the
  Lua scripts in Step 1 — see Gotchas #2 — no interest in a second one
  with a compiled `.node` file).
- `apps/api/src/modules/auth/` — new module:
  - `POST /auth/register` (email + password ≥8 chars, hashed with
    bcryptjs) always creates `role: 'user'` — no self-service path to
    `admin`, so nobody can grant themselves admin through the public API.
  - `POST /auth/login` — verifies password, returns a signed JWT
    (`{ sub: userId, role }`, `JWT_SECRET`/`JWT_EXPIRES_IN` from env).
  - `AdminBootstrapService` (`OnModuleInit`) — idempotently seeds one
    `role: 'admin'` user from `ADMIN_EMAIL`/`ADMIN_PASSWORD` env vars on
    boot if neither is empty and no user with that email exists yet.
    This is the only way an admin account gets created; credentials live
    in `.env` (gitignored), never in a migration or any committed file.
  - `JwtAuthGuard` — reads `Authorization: Bearer <token>`, verifies it,
    populates `request.user: { userId, role }`; 401 on anything missing/
    invalid/expired.
  - `RolesGuard` + `@Roles('admin')` decorator — must run after
    `JwtAuthGuard` (reads `request.user`, doesn't populate it); a route
    with no `@Roles()` metadata is open to any authenticated role.
  - `@CurrentUser()` param decorator — pulls `request.user` for handlers.
  - `AuthModule` is `@Global()`, and exports `JwtModule` itself
    alongside `JwtAuthGuard`/`RolesGuard` — **not** just the two guard
    classes. Hit this the hard way (see Gotchas #6): exporting only the
    guards and having feature modules `imports: [AuthModule]` was not
    enough for `@UseGuards(JwtAuthGuard)` to resolve in those modules;
    `JwtAuthGuard`'s own `JwtService` dependency has to be reachable
    through the same export/global chain, not just the guard class
    itself.
- Applied guards per controller:
  - `LocationsController`, `SlotsController`: class-level
    `@UseGuards(JwtAuthGuard)` (any authenticated role can `GET`), plus
    `@UseGuards(RolesGuard) @Roles('admin')` stacked on the `POST` method
    only (class-level and method-level `@UseGuards()` both run, in that
    order).
  - `ReservationsController`: class-level `@UseGuards(JwtAuthGuard)` on
    all three routes. `CreateReservationDto` no longer takes `userId` at
    all -- `ReservationsService.requestHold` now takes it as an explicit
    param sourced from `@CurrentUser()`, closing the "anyone can book as
    anyone" gap by construction rather than by validation.
  - `ReservationsService.confirm`/`cancel` now take the caller's
    `AuthenticatedUser` and call a new `assertOwnerOrAdmin` check right
    after the 404 lookup, before any status logic runs (so a non-owner
    gets a flat 403 with no information about the reservation's state,
    rather than a 200/409 that would leak it): `role === 'admin'` bypasses
    the check entirely, otherwise `reservation.userId` must equal the
    caller's `userId`.
- `.env.example`/`.env`: added `JWT_SECRET`, `JWT_EXPIRES_IN`,
  `ADMIN_EMAIL`, `ADMIN_PASSWORD`.

### Verified (ad hoc curl against real containers)

Built and ran `api` against the existing containers:

- `GET /locations` with no token → `401`.
- Logged in as the env-bootstrapped admin (confirmed
  `auth.admin_bootstrapped` in the boot log on first boot after the
  migration).
- `POST /auth/register` (alice) → `201` + token; registering the same
  email again → `409`; login with the wrong password → `401`.
- Alice (role `user`) attempting `POST /locations` → `403`.
- Admin created a location + slot → `201`/`201`; alice's token worked
  for `GET /locations` and `GET /slots` → `200`/`200` (both roles allowed
  on `GET`).
- Alice booked the slot with no `userId` in the request body at all —
  the returned reservation's `userId` matched her JWT's `sub`.
- Registered bob; bob attempting to confirm alice's reservation → `403`.
- Alice confirming her own reservation → `200`. Admin then cancelling
  that same (not-their-own) reservation → `200` (admin override works).
- A garbage bearer token → `401`.
- Rebuilt `notification-worker` and `event-consumer` too (both import
  `@lib/database`/`@lib/domain`, both touched by this step) to confirm
  the new `User` entity/`UserRole` type didn't break either -- both
  compiled clean.

All test rows cleaned up afterward (`DELETE` on seeded location/slot/
reservation rows and the alice/bob users -- admin user deliberately left
in place since it's meant to persist across restarts, `redis-cli
FLUSHDB`).

### Current environment state (as of pausing)

- All containers unchanged, still running/healthy.
- No `api` process left running.
- One `role: admin` user persists in Postgres
  (`admin@phastos.local`, from `.env`'s `ADMIN_EMAIL`/`ADMIN_PASSWORD` --
  local dev credentials only, not meant to ship as-is).

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
   _inferred_ from whichever files end up in the compiled program. Plain
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
   (commit `dad167b`) used the _same_ alias name `@/*` in every app,
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

6. **`@UseGuards(SomeGuard)` referencing a guard class exported from
   another module doesn't just work off `exports: [SomeGuard]`.** Adding
   `AuthModule` (providing/exporting `JwtAuthGuard`) to `LocationsModule`'s
   `imports` and marking `AuthModule` `@Global()` still failed at boot
   with `Nest can't resolve dependencies of the JwtAuthGuard (?) ...
   available in the LocationsModule context` -- `JwtAuthGuard`'s own
   constructor dependency (`JwtService`, from `JwtModule`, imported but
   not re-exported by `AuthModule`) wasn't reachable via that export
   chain even though the guard class itself was. Fixed by also exporting
   `JwtModule` itself from `AuthModule` (`exports: [JwtModule,
   JwtAuthGuard, RolesGuard]`) -- a guard referenced by class in
   `@UseGuards()` apparently needs its *entire* dependency chain visible
   through exports/globals from the consuming module's perspective, not
   just the guard token. Worth remembering for any future guard/
   interceptor/pipe that takes constructor dependencies and gets shared
   across modules this way.

## Next step: real notifications / event-consumer, or GET /reservations/:id

All four infrastructure legs, the reservation lifecycle HTTP endpoints
(Step 6), the full locations/slots admin+browse surface (Step 7 create,
Step 8 list), and JWT auth/authz with two roles (Step 9) are built and
verified end-to-end. No payment step is planned — this is a free
appointment-booking system (Apple Genius Bar-style), not a paid
reservation. What's left before this is a real system:

- No `GET /reservations/:id` (or list) endpoint yet — add if/when a
  client needs to poll a single reservation's status or a user needs to
  see their own bookings. Would need the same ownership check pattern as
  `confirm`/`cancel` (Step 9).
- `JWT_SECRET`/`ADMIN_PASSWORD` in `.env`/`.env.example` are local-dev
  placeholders (`dev-secret-change-me` / `phastos-admin`) — must be
  overridden with real secrets outside local dev; nothing enforces that
  today.

Solid and verified end-to-end:

- Slot-hold concurrency (Redis atomic claim/confirm/release, no double-booking even under a thundering herd)
- Postgres capacity trigger as a hard backstop if Redis is ever bypassed/stale
- Kafka lifecycle events, RabbitMQ notification queues with retry/DLQ, reminder sweep
- The three reservation endpoints (POST /reservations, /confirm, /cancel) tying it all together, now identity-checked against the caller's JWT rather than a client-supplied userId
- Locations/slots admin+browse endpoints (POST/GET /locations, POST/GET /slots) — a freshly created slot is immediately bookable with no manual Redis seeding, and GET /slots reports live availability computed against Postgres
- JWT auth with two roles (user/admin): register/login, admin-only location/slot creation, and reservation ownership enforced (a user can only confirm/cancel their own booking; admin can act on any)

Missing before a real user could actually use it:

- A user can now discover bookable slots end-to-end through the API
  (`GET /locations` → `GET /slots?locationId=...` → `POST /reservations`)
  — the "can't discover a slot ID" gap from Step 6/7 is closed.
- Auth now exists end-to-end (Step 9) — the "anyone can book/cancel as
  anyone" gap is closed for reservations, and locations/slots creation is
  admin-gated.
- Notifications aren't real. notification-worker validates the payload and logs notification.delivered — there's no actual SendGrid/SES/email integration, so "confirmation email" and "reminder" don't send anything today.
- event-consumer is a stub too — it dedupes and logs, but there's no real analytics/audit/inventory-sync behind it.

Missing before it's production-ready even with the above filled in:

- No tests (zero .spec.ts files in the repo)
- No CI/CD, no Dockerfiles for the three apps themselves (only their infra dependencies run in docker-compose)
- No API docs (no Swagger/OpenAPI)
- No rate limiting beyond DTO validation
