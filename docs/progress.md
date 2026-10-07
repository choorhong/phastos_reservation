# Progress Log

Tracks what's actually been built, in what order, so this can be picked back
up without re-deriving context. See `docs/architecture.md` for the architecture/design —
this file is just the build log against that plan.

---

## Status: paused after Step 30 (deploys switched to DigitalOcean); next up is the Droplet and the first deploy

## Decisions locked in (see `docs/architecture.md` "Decisions")

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
libs/kafka-contracts       # reservation-events.ts — full envelope + payload types from docs/architecture.md §3
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
  - `DatabaseModule` — `TypeOrmModule.forRootAsync` via `ConfigService`
    (now `AppConfigService` — see Step 10),
    **`synchronize: false` always** (schema only moves through migrations,
    so the trigger below is never silently dropped by a sync).
  - `data-source.ts` — `DataSource` config for the TypeORM CLI.
  - `libs/database/migrations/1789211003000-InitialSchema.ts` — creates all
    three tables, plus **`enforce_slot_capacity`**: a `BEFORE INSERT OR
UPDATE OF status` trigger on `reservations` that row-locks the slot
    (`SELECT ... FOR UPDATE`) and refuses to let a row become `confirmed`
    if that would exceed the slot's `capacity`. This is the DB-level
    defense-in-depth from `docs/architecture.md` §2 — it holds even if Redis is
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
  Cluster compatibility (docs/architecture.md §2) — populated instead as a best-effort
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
    docs/architecture.md §2: `PSUBSCRIBE __keyevent@*__:expired` (fast path) +
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
    docs/architecture.md §4, one `notifications` direct exchange + one
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
  docs/architecture.md §5. Healthcheck via `kafka-broker-api-versions`.
- `.env.example` / `.env`: added `KAFKA_BROKERS`, `KAFKA_CLIENT_ID`,
  `KAFKA_TOPIC_REPLICATION_FACTOR` (1 locally, 3 in docs/architecture.md's non-local
  guidance), `EVENT_CONSUMER_GROUP_ID`.
- `libs/database`: new `ProcessedEvent` entity (`processed_events`,
  composite PK `(event_id, consumer_name)` -- docs/architecture.md §3's
  idempotent-consumption ledger; composite rather than `event_id` alone so
  multiple downstream consumers can dedupe independently against the same
  event) + migration `AddProcessedEvents`. Added to `DatabaseModule`'s
  `entities`/`forFeature` and `data-source.ts`.
- `libs/kafka-contracts/src/reservation-events.ts` (envelope + payload
  types already existed from Step 1; added the runtime pieces):
  - `ensureReservationEventsTopic(admin, replicationFactor)` -- idempotent
    topic creation (`partitions: 12` per docs/architecture.md §3), run by both apps on
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
  four infra legs per docs/architecture.md §4's direct-vs-queue split:
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
  "Payment authorization" row was dropped from docs/architecture.md §4's table — it
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

## Step 10 — Typed, no-defaults env config (`@lib/config`) ✅

Commits `83905c3` (introduce the lib, migrate every consumer) and `5efc2eb`
(single schema, drop defaults, add `list`/`boolean`).

Before this, every env read was either `ConfigService.get('X', 'default')`
or a raw `process.env.X ?? default`, with the defaults scattered across ~20
files (and a silent `localhost`/`phastos`/`guest` fallback if a variable
was forgotten). Now there is one place that declares, parses and validates
every variable.

- `libs/config` (`@lib/config`, registered in `nest-cli.json` and the root
  `tsconfig.json` paths):
  - `environment-schema.ts` — **the one place a variable is declared**:
    its name, its parse type (`string | number | boolean | list`) and
    whether it may be absent (`optional: true`). Everything else is
    derived from it: the `EnvironmentVariables` type (so
    `get('POSTGRES_PORT')` is `number`, `get('KAFKA_BROKERS')` is
    `string[]`, only optional variables can be `undefined`), the
    `EnvKey` name constants (`EnvKey.POSTGRES_HOST`), and the runtime
    parsing. Adding a variable is one line.
  - `environment-variables.ts` — calls `dotenv.config()` itself (see the
    note below), then walks the schema over `process.env` **once at
    import time** and exports `environmentVariables`.
  - `app-config.service.ts` — `AppConfigService.get(key)` /
    `getOrThrow(key)`, typed against the schema; a typo in the key is a
    compile error.
  - `app-config.module.ts` — `@Global()`, imported once by each
    `AppModule`.
- **No defaults, in any environment.** A missing or blank variable makes
  startup throw one error listing every missing name
  (`Missing required environment variable(s): A, B`) before Nest builds
  any module. Only `ADMIN_EMAIL`, `ADMIN_PASSWORD` (unset = "skip admin
  bootstrap") and `NODE_ENV` may be absent. A malformed number throws
  `Invalid environment variable X: expected a number, got "..."`.
- Parse types: `number` (`Number()`, rejects NaN), `boolean` (`true`/
  `false`/`1`/`0`, case-insensitive; anything else throws rather than
  guessing), `list` (comma-separated, items trimmed, empty items dropped;
  a list with no items counts as missing). No current variable is a
  boolean; the parser is there for the first feature flag.
- `KAFKA_BROKERS` is now a `list`, so the two `.split(',')` calls in the
  Kafka producer/consumer providers are gone.
- Migrated to `AppConfigService`: all three `main.ts` (port), the
  Redis/RabbitMQ/Kafka providers, auth module + admin bootstrap, hold
  claim/reaper, notification consumers + reminder sweep, and
  `DatabaseModule`. `libs/database/src/data-source.ts` (the TypeORM CLI
  data source, which used to carry its own hardcoded defaults) now reads
  `environmentVariables` too, so **`npm run typeorm -- migration:run`
  needs the full variable set, not just the Postgres ones**.

### Things worth knowing

- **Every app requires every variable.** All three apps import the same
  schema, so `event-consumer` will refuse to start without `RABBITMQ_*` or
  `REMINDER_*` even though it never uses them (likewise `JWT_SECRET` and
  the other apps' ports). Fine while the apps are deployed from one
  `.env`; if they're ever deployed separately, split the schema per app.
- **Read once, never re-read.** Changing `process.env` or `.env` while an
  app runs has no effect until restart.
- **`.env` vs real environment.** `dotenv` does not override variables
  that are already set, so a real environment variable beats `.env`. A
  `.env` left in a production working directory would also be picked up
  and satisfy the check.
- **`dotenv.config()` lives in the config lib on purpose.** The module's
  top-level code can run before `ConfigModule.forRoot()` does (ES imports
  resolve before the importing file's own statements), so relying on
  `forRoot()` to load `.env` first would be order-dependent.
- `ConfigModule.forRoot({ isGlobal: true })` is still in each `AppModule`.
  It is now redundant (nothing reads `@nestjs/config`'s `ConfigService`
  any more) and was left alone.
- The one remaining raw `process.env` read outside the lib is `NODE_ENV`
  in `libs/common/src/observability.module.ts`.
- **`.prettierrc` added** (`singleQuote`, `trailingComma: "all"`,
  `printWidth: 100`). There was none before, so prettier's defaults (double
  quotes, 80 columns) — including the editor's format-on-save — kept
  rewriting files away from the single-quoted style the repo was written
  in. The three settings were picked by checking candidates against the
  77 `.ts` files at `de516cc` (before any config work): this combination
  matched 67 of them, the best of any width/trailing-comma combination
  tried. `redis-client.provider.ts` and `environment-variables.ts`, which
  the editor had switched to double quotes, were reformatted back. About
  ten older files (e.g. `hold-reaper.service.ts`,
  `notification-consumers.service.ts`, the first migration) still don't
  match — they were hand-wrapped at other widths — and were left alone
  rather than mixing a repo-wide reformat into this change. `npm run
  format` will fix them whenever you want that as its own commit.

### Verified (against the real containers; ad hoc scripts, not committed)

- `tsc --noEmit` clean; all three apps build (`npm run build:all`) and boot;
  `/health` returns `ok` on each.
- Type-level assertions (throwaway file, deleted): `get('POSTGRES_PORT')` is
  `number`, `get('KAFKA_BROKERS')` is `string[]`, `get('ADMIN_EMAIL')` is
  not assignable to `string`, and a typo in `get(...)` / `EnvKey.X` does not
  compile.
- Parsing: real `.env` loads with correct types; a blank required variable,
  two missing variables, `API_PORT=abc`, and `KAFKA_BROKERS=','` all throw
  the expected error; a blank `ADMIN_EMAIL` is accepted; `list` cases
  (`a:9092, b:9092`, stray commas) and ten `boolean` inputs (via a
  temporary schema entry, reverted).
- Fail-fast on the built bundles: blank `JWT_SECRET` stops all three apps;
  blank `POSTGRES_PASSWORD` stops the api with exit code 1.
- End-to-end, 19/19 checks over HTTP: admin login, wrong password (401), no
  token (401), register, duplicate register (409), non-admin creating a
  location (403), admin creating location/slot, browse (token required),
  reserve → `held`, second user on a full slot (409), confirm → `confirmed`
  (200 by design), cancel → `cancelled` (200 by design), slot bookable again.
  `event-consumer` processed `ReservationRequested/Confirmed/Cancelled` and
  `SlotReleased`; `notification-worker` delivered `confirmation-email` and
  `receipt`.
- Schedulers, with intervals set through real environment variables:
  `REMINDER_SWEEP_INTERVAL_MS=5000` → `reminder.sweep.enqueued` for a
  confirmed booking 30 minutes out; `HOLD_TTL_SECONDS=5` → the unconfirmed
  hold was reaped. **Not proven:** the reaper logged `reapedBy:
  "notification"` (the Redis keyspace fast path), so
  `HOLD_REAPER_SWEEP_INTERVAL_MS` was read without error but the periodic
  sweep itself wasn't observed firing.

### Current environment state (as of pausing)

- All containers unchanged, still running/healthy. No app processes left
  running.
- **Unlike earlier steps, test data was not cleaned up**: the dev database
  still has several `Verify HQ` / `Full Check HQ` / `Sched HQ` locations with
  their slots and reservations, plus `verify…`, `full…` and `sched…`
  `@example.com` users. The admin user is still there as usual.

## Step 11 — Slots generated by rule, not entered by admins ✅

Admins no longer create slots one at a time. One global rule — **weekdays
only, 10:00–18:00 in each location's own timezone, 2h blocks, 3 spots per
slot** — is turned into real `slots` rows for today plus the next 30 days.

### What changed

- **Rule in env config** (`environmentSchema`, all required, no defaults):
  `SLOT_OPEN_HOUR`, `SLOT_CLOSE_HOUR`, `SLOT_DURATION_HOURS`, `SLOT_CAPACITY`,
  `SLOT_WINDOW_DAYS`, `SLOT_GENERATION_INTERVAL_MS`. "Weekdays only" is a
  constant in `slot-schedule.ts`, not a variable. An invalid rule (e.g. a
  duration that doesn't tile the day) fails at boot.
- **`slot-schedule.ts`**: pure `buildSlotWindows(timezone, rule, now)` built
  on `luxon` (new dependency). Hours are wall-clock in the location's
  timezone, so DST moves the UTC instants but not the local hours. "Today"
  is the location's today, and slots already started are never back-filled.
- **`SlotGeneratorService`**: "ensure the whole window exists" (not "create
  day N+30"), so downtime, restarts and new locations self-heal. Runs on
  startup and every `SLOT_GENERATION_INTERVAL_MS` (same `SchedulerRegistry`
  interval pattern as `HoldReaperService`), and immediately when a location
  is created (`LocationsService.create`; a failure there is logged, not
  raised — the sweep fills in later).
- **Migration `UniqueSlotStartPerLocation`**: unique index on
  `(location_id, start_time)`, replacing the plain one. This is what makes
  `INSERT ... ON CONFLICT DO NOTHING` idempotent, and so safe with several
  api instances running the job at once. It fails if existing rows already
  duplicate a pair.
- **API**: `POST /slots` and `CreateSlotDto` are **removed**. Added
  `POST /slots/generate` (admin, runs the sweep now, returns `{created}`)
  and `PATCH /slots/:id` (admin, `{capacity}` — `0` closes a slot, e.g. a
  holiday; capped at `SLOT_CAPACITY`, and 409 if below the slot's active
  `held`+`confirmed` reservations). `GET /slots` is unchanged.
- **Local times on `GET /slots`**: each slot now also carries `timezone`,
  `localDate` (`2026-09-21`), `localStartTime` and `localEndTime` (`10:00`,
  `12:00`), computed on the way out from the UTC instants plus the
  location's timezone (`@lib/time`, luxon; it lived in `apps/api` until Step 12) — **not stored**, since
  they're derived and would drift if a timezone were corrected. The UTC
  `startTime`/`endTime` are unchanged. Clients still get the raw instants
  for exact maths, but no longer need their own timezone logic to show the
  right day and time to a viewer in another timezone.
- **`GET /slots?locationId=…&date=YYYY-MM-DD`**: one calendar day in the
  *location's* timezone, turned into a UTC range so it uses the plain
  `start_time` index (23/25h on daylight-saving days). Needs `locationId`
  and can't be combined with `from`/`to` (400); an impossible date is 400,
  an unknown location 404. Still floored at now, like the default listing.
- **Tests**: first specs in the repo — `slot-schedule.spec.ts` (weekend
  skipping, DST, no back-fill, per-location "today", rule validation),
  `slot-local-time.spec.ts` (Singapore vs Los Angeles, UTC-day rollover,
  23/25h days) — 20 tests in all, and
  the first `jest.config.js` (path aliases derived from the root tsconfig).

### Things worth knowing

- `PATCH` also adjusts the cached `slot:{id}:available` counter by the
  capacity delta (only if the key exists). A claim that seeds the key
  between the DB commit and that adjustment can see the delta applied
  twice; the `enforce_slot_capacity` trigger still prevents overbooking.
- The generator never touches existing rows, so a slot an admin closed
  stays closed and slots with reservations are unaffected.
- **Holidays aren't modelled** — an admin closes those slots with `PATCH`.
- The rule is global. Per-location hours/capacity would mean moving these
  values onto `Location`.
- Existing slots created by hand that are off the new grid stay as they are;
  they're just ordinary rows.

### Local-time conversion still to do (notifications)

The rule is the same everywhere: **store and pass around UTC instants,
convert to the location's timezone (`locations.timezone`) only when a person
will read the value** — and always with an explicit timezone, never the
machine's or the viewer's default (a Singapore Monday 10:00 slot is Sunday
7pm for a viewer in California). `GET /slots` (this step) and the
reservation endpoints (Step 12) now do this. Still to do:

- ~~**RabbitMQ payloads**~~ — done in Step 15: both payloads now carry
  `timezone`.
- ~~**Real email rendering**~~ — done in Step 23: emails show store-local
  time via `toSlotLocalTimes`, with the IANA zone named
  ("2026-10-02, 10:00–12:00 (America/Los_Angeles)"). Users still have no
  timezone of their own, so a second line in the viewer's zone would need
  one first.
- **Kafka events** (`libs/kafka-contracts`, `ReservationConfirmedPayload`):
  `slotStartTime`/`slotEndTime` as ISO UTC is right for machine consumers,
  so leave them. If a consumer ever needs local time it has `locationId` in
  the envelope; adding `timezone` to the payload is cheap if that happens.
- **Not affected:** the reminder window (`REMINDER_LEAD_MINUTES`) and hold
  expiry compare absolute instants, so they are correct in any timezone.

### Verified (against the real containers; ad hoc curl, plus jest)

- Startup sweep created 84 slots for each of the 6 leftover test locations.
- Created an `America/Los_Angeles` location: 84 slots appeared immediately,
  first Mon 2026-09-21 at 17:00Z/19:00Z/21:00Z/23:00Z (PDT), none on
  weekends. `POST /slots/generate` again → `created: 0`.
- `PATCH` capacity `0` worked and survived a re-run of generation; `4` → 400;
  `0` with one active hold → 409; `3 → 2` with one hold dropped both
  `available` and the Redis counter by 1. Non-admin got 403 on both admin
  endpoints; `POST /slots` is now 404.
- Local-time fields and the `date` filter checked live for Orchard and
  Santa Monica (same date → Singapore 02:00Z vs Los Angeles 17:00Z, both
  shown as 10:00 local), plus the 400/404 cases.
- 20 jest tests passing.

### Current environment state (as of pausing)

- Containers unchanged and healthy; api stopped. Migration applied.
- The extra test location, user and reservation from this step were deleted,
  and so were the 6 older `Verify HQ` / `Full Check HQ` / `Sched HQ` test
  locations with their slots and reservations. The dev database now has **no
  locations or slots** (create a location and its slots are generated at
  once). The admin user and the `@example.com` test users are still there.

## Step 12 — `GET /reservations`, reservation responses with local times, `@lib/time` ✅

### What changed

- **New lib `@lib/time`** (`libs/time`, registered in the root `tsconfig.json`
  paths and `nest-cli.json` like the other libs): `toSlotLocalTimes` and
  `localDayRange`, moved out of `apps/api/src/modules/slots` (history kept
  with `git mv`) so `notification-worker` can use them too. Its spec moved
  with it.
- **`ReservationView`** (`reservation-view.ts`): what every reservation
  endpoint now returns instead of the bare entity — `id`, `status`, `userId`,
  `slotId`, `createdAt`, `confirmedAt`/`cancelledAt`/`cancelReason` (`null`
  when unset), `slot` (`id`, UTC `startTime`/`endTime`, plus `timezone`,
  `localDate`, `localStartTime`, `localEndTime`) and `location` (`id`,
  `name`, `address`). **Behaviour change:** `holdId`, `correlationId`,
  `reminderSentAt` and `updatedAt` are no longer in responses (internal),
  and `confirm` no longer leaks the nested raw `slot.location` entity.
- **`GET /reservations`**: the caller's own bookings, soonest slot first,
  optional `?status=held|confirmed|cancelled|expired` (else 400). Admins get
  their own here too — it is "my bookings", not "all bookings".
- **`GET /reservations/:id`**: same ownership rule as confirm/cancel (owner
  or admin → 200, someone else → 403, unknown → 404).
- `POST /reservations`, `/confirm` and `/cancel` return the same view
  (`requestHold` now loads the slot's location; `cancel` loads
  `slot.location`).
- **Tests**: `reservation-view.spec.ts` (local times per location, nulls,
  internal fields hidden) and `reservations.service.spec.ts` (ownership and
  filter rules of the two reads, with mocked repository) — 30 jest tests in
  all.

### Things worth knowing

- Nothing filters out past reservations; a client that wants "upcoming" only
  has to compare `slot.startTime` itself (or we add a query param later).
- Group a list by `slot.localDate` (the location's date), not by the
  viewer's local date, or Singapore's Monday slots land under Sunday for a
  viewer in California.
- The service spec is a unit test with a mocked repository; the real
  end-to-end flow test is still the top item under "Next step".

### Verified (against the real containers; ad hoc curl, plus jest)

- As one user: booked Orchard (Tue 22 Sep 10:00 SGT = 02:00Z) and Santa
  Monica (12:00 PDT = 19:00Z); `create`, `confirm`, `cancel` all returned
  the view with the correct local time and timezone for each location.
- `GET /reservations` listed both soonest-first; `?status=confirmed` and
  `?status=cancelled` filtered correctly; `?status=bogus` → 400; a second
  user's list was `[]`.
- `GET /reservations/:id`: owner 200, other user 403, admin 200, unknown 404,
  no token 401. The create response's keys had no `holdId`/`correlationId`.
- No errors in the api log.

### Current environment state (as of pausing)

- Containers unchanged and healthy; api stopped. Test users and reservations
  from this step were deleted. Dev database: Orchard and Santa Monica (84
  slots each), the admin, and the older `@example.com` test users.

## Step 13 — End-to-end test suite ✅

### How to run

```bash
docker compose up -d          # Postgres, Redis, RabbitMQ, Kafka must be up
cp .env.example .env          # if not already there (hosts, credentials, JWT secret)
npm run test:e2e              # ~20s; boots the real api and drives it over HTTP
npm test                      # the fast unit tests only (does not touch the e2e suite)
npm run test:e2e:db           # just (re)prepare the test database, without running tests
E2E_LOGS=1 npm run test:e2e   # same, with the app's logs switched back on
```

### What it does

- **Real app, real services.** `createApp()` boots the actual `AppModule`
  (same `configureApp()` request handling as `main.ts`, now shared in
  `apps/api/src/app.setup.ts`) against the docker-compose Postgres, Redis,
  RabbitMQ and Kafka, listening on a free port, driven with `supertest`.
- **Isolated database.** A separate `phastos_reservation_test` database, so
  the dev data is never touched. `test/e2e/setup-db.ts` (run by jest's
  `globalSetup`) checks all four services are reachable (with a hint to run
  `docker compose up -d` if not), creates the database if missing, runs the
  migrations and truncates every table, so each run starts empty. Redis keys
  are UUID-scoped per slot and each suite deletes the ones it touched.
- **Deterministic config.** `test/e2e/env.ts` overrides what the tests rely
  on (test DB name, admin credentials, `HOLD_TTL_SECONDS=3`, and the slot
  rule 10–18 / 2h / capacity 3 / 30 days). dotenv never overrides an
  already-set variable, so these win over `.env`; everything else still
  comes from `.env`.
- **Real brokers are exercised.** Kafka and RabbitMQ publishers are
  spied on *pass-through* (calls still reach the brokers) and the tests
  assert every publish resolved — the service only logs publish failures,
  so without this a broken broker would go unnoticed.
- Files: `test/e2e/{auth,catalog,reservations}.e2e-spec.ts` plus
  `support.ts` (helpers), `env.ts`, `setup-db.ts`, `global-setup.ts`;
  config in `jest.e2e.config.js` and `test/tsconfig.json`.

### What is covered (72 tests)

- **Auth & access (25):** register/login validation, duplicate email, a
  client-supplied `role: admin` ignored, login errors indistinguishable,
  every protected route → 401 without a token (and with a garbage/tampered
  one), the three admin-only routes → 403 for a user.
- **Locations & slots (~25):** location validation, slots generated on
  location creation (weekdays only, 10–18 in 2h blocks, 3 spots, none in the
  past or beyond 30 days, four per full day), generation idempotent, `POST
  /slots` gone, Singapore vs Los Angeles local times for the same date,
  `?date` filtering and its 400/404 cases, closing/reopening a slot via
  `PATCH` (survives a generation run), capacity validation.
- **Reservations (~20):** hold → confirm → cancel with the slot's
  availability checked in both Postgres and Redis at each step; events and
  notifications published and accepted by the brokers; idempotent confirm
  and cancel (no double publish); cancelling an unconfirmed hold; a
  cancelled reservation can't be confirmed; bad ids; system-only cancel
  reason rejected; `GET /reservations` scoped to the caller, soonest first,
  status filter; ownership (other user 403, admin allowed, a `userId` in the
  body ignored); a full slot turns the 4th person away and admits them after
  a cancel; closed slots; `PATCH` can't shrink below active reservations and
  updates the live Redis counter; **12 people racing for 3 spots → exactly 3
  win** (Postgres rows, Redis counter and reported availability all agree,
  and 3 simultaneous confirms leave exactly 3 confirmed); 10 racing for the
  last spot → exactly 1; hold expiry hands the spot to the next person and
  the late confirm gets 410; an abandoned hold becomes `expired` in Postgres
  with the `hold_expired` events published and stops blocking the admin; a
  hold confirmed in time is left alone; the Postgres capacity trigger
  refuses to overfill with Redis bypassed, and when the Redis counter is
  deliberately made stale (→ 409, reservation closed off).

### Findings (things the suite showed that were not known before)

1. **An abandoned hold was never marked `expired` in Postgres — FIXED.** The
   reaper only returned the spot in Redis, so the row stayed `held` forever:
   it permanently lowered `available` on `GET /slots` (which counts
   `held`), showed as `held` in the user's `GET /reservations`, and stopped
   an admin shrinking that slot. (No overbooking: the DB trigger counts only
   `confirmed`.) Now `HoldReaperService` also moves the row to `expired`
   with `cancelReason: 'hold_expired'` — conditionally on it still being
   `held`, so a confirm/cancel that got there first wins and nothing is
   published twice — and publishes `ReservationCancelled` and `SlotReleased`
   with reason `hold_expired` (the events `libs/kafka-contracts` already
   defined and nothing sent). `SlotsModule` now imports `EventsModule`.
   Consequences: a late confirm on a reaper-expired reservation still
   returns **410 Gone** (`confirm` maps `expired` → 410 instead of the
   generic 409), and the confirm-time expiry path sets the same
   `hold_expired` reason. A failure while expiring is logged
   (`slot.hold.expire_reservation_failed`) and never stops the reaper.
2. **A confirm blocked by the Postgres capacity trigger returned a bare 500 —
   FIXED.** With a stale Redis counter the trigger correctly refuses the
   second confirmation (invariant tested), and the API now answers
   `409 Slot … is already full` and closes the reservation off as
   `cancelled` (its Redis hold is already consumed, so nothing would ever
   clean up a `held` row) instead of leaving it dangling. No events are
   published for that cancellation (**changed in Step 22**: it now gets
   `cancelReason: 'slot_full'` and a `ReservationCancelled` event), and the Redis counter is left alone
   (it was stale-high, so it is already wrong in the safe direction).
   Writing the test caught a bug in the first version of this fix: saving the
   entity again wrote its in-memory `confirmedAt` into the cancelled row; it
   now uses a targeted `update`.
3. **The same user can hold several spots in one slot** — `requestHold` has
   no per-user check, so one account can take all 3 spots. Seen by reading
   the code; not tested, and it may be fine if that is intended.
   **FIXED in Step 16** (one active reservation per user per slot).
4. **Nothing closed the Kafka/RabbitMQ/Redis connections on shutdown —
   FIXED**, so jest could not exit after `app.close()` and a real SIGTERM
   killed the process without closing them. `KafkaShutdownService`,
   `RabbitmqShutdownService` and `RedisShutdownService` close them in
   `onApplicationShutdown` (after every module's own destroy hooks, so the
   hold reaper can still unsubscribe), and `main.ts` now calls
   `app.enableShutdownHooks()`. Checked on the built app: SIGTERM → exits in
   about a second, no errors, Redis client list back to just the CLI.

### Things worth knowing

- **Test data reaches the real Kafka topic and RabbitMQ queues.** Only
  Postgres is isolated; the brokers are the dev ones, so a running
  `event-consumer` or `notification-worker` will see the test events (for
  users/reservations that don't exist in the dev database).
- **`@nestjs/jwt` 12 is ESM-only**, which jest (CommonJS) can't load, so the
  e2e config transpiles that one package (`allowJs` in `test/tsconfig.json`
  plus a `transformIgnorePatterns` exception). The webpack builds are
  unaffected.
- `libs/common` request logging is now `silent` when `NODE_ENV=test` (jest
  sets it); `E2E_LOGS=1` restores it.
- The hold-expiry tests wait for the 3 s TTL plus the reaper, so they are
  the slow ones (a few seconds each; the whole suite takes ~25 s). Timing-based waits poll (`eventually`)
  instead of sleeping a fixed time.
- Not covered: the notification-worker and event-consumer apps, the reminder
  sweep, and reading the events back off Kafka/RabbitMQ (only that the
  publishes succeeded). A test that drives those needs the other apps
  booted too.
- A kafkajs `TimeoutNegativeWarning` line appears in the output. It comes
  from inside kafkajs's request queue and is harmless (Node clamps it to
  1 ms).

### Current environment state (as of pausing)

- Containers unchanged and healthy; nothing running. A
  `phastos_reservation_test` database now exists alongside the dev one (it
  is emptied at the start of each e2e run). The dev database is unchanged:
  Orchard and Santa Monica with 84 slots each, the admin and the older
  `@example.com` users. No leftover Redis keys.

## Step 14 — Unit tests for `@lib/config` ✅

### What changed

- **`load-environment.ts` (new)**: the parsing that used to be a private
  `load()` inside `environment-variables.ts`, now the exported pure function
  `loadEnvironment(env, schema = environmentSchema)`. It touches neither
  dotenv nor `process.env`, so it can be run against any environment.
  `environment-variables.ts` is now just `loadDotenv()` plus
  `loadEnvironment(process.env)`. **No behaviour change**: same parsing, same
  error messages. The split was needed for testing: importing
  `environment-variables.ts` loads the real `.env` and validates it on the
  spot, so the missing-variable cases couldn't be exercised, and the import
  itself would throw anywhere there is no `.env` (e.g. CI).
- **`load-environment.spec.ts` (46 tests)**: each parse type against a small
  custom schema (the real one has no `boolean` yet) — numbers (incl. `1e3`,
  rejecting `abc`/`12px`/`NaN`), booleans (case/whitespace, rejecting
  `yes`/`on`/`2`), lists (trimming, stray commas, no items = missing); empty
  string or whitespace-only = unset; every missing name in one error in schema order; a
  malformed value throws before the missing-list does; optional variables.
  Plus three checks against the *real* schema: a full environment loads,
  exactly `ADMIN_EMAIL`/`ADMIN_PASSWORD`/`NODE_ENV` are optional, and the ADMIN
  pair may be absent.
- **`app-config.service.spec.ts` (5 tests)**: `get`, `getOrThrow` (with the
  variable named in the error), and `EnvKey` matching the schema's keys
  exactly. Mocks `./environment-variables` for the same import-time reason.
- 81 jest tests in all (`npm test`), no services or `.env` needed.

### Things worth knowing

- **Every value is trimmed before it is read** (`env[name]?.trim()`), so a
  whitespace-only variable counts as unset. Writing the tests turned up that
  without this, `PORT="  "` was parsed as `0` (`Number('  ')`) and a
  whitespace-only string was accepted as a value. **Side effect:** string
  values are trimmed too, so a secret with deliberate leading/trailing spaces
  (only possible via a quoted value, since dotenv already trims unquoted ones)
  would be altered.

## Step 15 — `timezone` on the confirmation-email and reminder payloads ✅

### Why

Slot times are stored and passed as UTC instants. A consumer that renders
them for a person needs the location's IANA zone, and the payloads carried
only `locationName` plus UTC ISO strings. A worker that formatted them
without a zone would use its own server's timezone, so a Singapore Monday
10:00 slot (`02:00Z`) would read "Monday 02:00" on a UTC container.

### What changed

- `libs/rabbitmq-contracts/src/notification-messages.ts`: `timezone: string`
  added to `ConfirmationEmailPayload` and `ReminderPayload`.
  `ReceiptPayload` is unchanged (it has `confirmedAt` only, no slot times).
- `reservations.service.ts` (confirm path) sends `slot.location.timezone`.
- `reminder-sweep.service.ts` sends `reservation.slot.location.timezone`.
  Both sites already loaded `slot.location`, so no extra query.
- The slot times stay UTC ISO strings; only the zone was added, so the
  instants remain usable for exact maths.

### Things worth knowing

- **Nothing reads the field yet.** The worker still only validates the
  payload and logs `notification.delivered`. When real emails are built, the
  worker should call `toSlotLocalTimes(payload.timezone, new Date(start),
  new Date(end))` from `@lib/time` (returns `localDate`, `localStartTime`,
  `localEndTime`). That already covers correctness; it does not give weekday/
  month names or a zone abbreviation ("SGT"), which are cosmetic and can be
  added to `SlotLocalTimes` if the email text needs them.
- **`timezone` is required, not optional.** Messages already sitting in
  `q.confirmation-email` / `q.reminder` from before this change lack it.
  Irrelevant locally; in a deployed system, drain the queues first or have
  the worker fall back to looking it up from the reservation.
- The consumer's payload check (`notification-consumers.service.ts`) only
  requires `reservationId`/`userId`; it does not check `timezone`. Add that
  when the consumer starts using it.

### Verified

- `tsc --noEmit` clean; 81 jest tests pass.
- **Not run:** the e2e suite (needs the four containers) and a live publish.
  The e2e suite only spies on `publishConfirmationEmail`, so it is not
  expected to be affected.

## Step 16 — One spot per person per slot ✅

Resolves Step 13, finding 3: one account could hold every spot in a slot.

### What changed

- **"Person" means `userId`** — the `users` table's UUID primary key, the
  JWT `sub`. Email is unique on `users`, but the reservation code never sees
  it, and the rule cannot stop someone registering a second account.
- **Pre-check in `ReservationsService.requestHold`**: if the user already has
  a `held` or `confirmed` reservation for the slot, 409 before anything is
  claimed in Redis.
- **Migration `OneActiveReservationPerUserPerSlot`**: partial unique index
  `uq_reservations_active_user_slot` on `(slot_id, user_id) WHERE status IN
  ('held', 'confirmed')`, also declared on the `Reservation` entity
  (`ACTIVE_RESERVATION_UNIQUE_INDEX`). This is the race-proof backstop.
  Cancelled and expired rows are outside the index, so a user can book the
  slot again after cancelling.
- **Redis cleanup on the race path**: when two requests from one user pass the
  pre-check together, the loser has already taken a spot in Redis before its
  insert hits the index. The service now catches that specific violation
  (Postgres `23505` on that constraint name), calls `SlotHoldService.release`
  and returns 409. Other unique violations (e.g. `hold_id`) are not treated as
  duplicates and still surface as errors.

### Things worth knowing

- **The migration fails if existing data breaks the rule** (a user with two
  active reservations on one slot). The comment in the migration has the query
  to find them; cancel the extras by hand first. It is applied to both the
  e2e database and the dev database (checked with `migration:show`: all six
  migrations run, and `uq_reservations_active_user_slot` exists in the dev
  database with the `held`/`confirmed` predicate).
- Between a hold's Redis TTL expiring and the reaper marking its row
  `expired`, that user gets a 409 if they rebook. It clears within a reaper
  cycle.
- `confirm` is unaffected: `held` → `confirmed` stays inside the index's
  predicate, so it never changes a row's uniqueness.

### Verified

- `tsc --noEmit` clean; 84 jest tests (3 new: pre-check runs before the Redis
  claim, the race path releases the spot, other unique violations are not
  swallowed); e2e suite 76/76 against the real containers.
- New e2e tests: second hold refused before and after confirm with the
  Postgres and Redis counts unchanged, and other users unaffected; rebooking
  after cancel; six simultaneous holds from one user give one 201 and five
  409s with Redis and Postgres availability both ending at 2; and a direct SQL
  insert bypassing the API is rejected by the index (cancelled/expired rows are
  allowed).
- Mutation check: with the `release` call removed, the simultaneous-requests
  test fails (`Expected: 2, Received: 0`), so it does guard the Redis cleanup.

## Step 17 — `PATCH /locations/:id` ✅

Locations could be created and listed but never corrected.

### What changed

- **`PATCH /locations/:id`** (admin only; `ParseUUIDPipe` on the id, so a
  malformed id is 400 and an unknown location 404). New `UpdateLocationDto`
  and `LocationsService.update`, in `apps/api/src/modules/locations/`.
- **Only `name` and `address` are editable**, and either may be sent alone.
  An empty string or a non-string value is 400 (same rules as create).
- **Everything else in the body is ignored, not rejected** — `timezone`
  included, and any other field (`id`, `slots`, …). This needs no extra code:
  the global `ValidationPipe({ whitelist: true })` already drops properties
  the DTO doesn't declare. A body with no editable field returns the location
  unchanged with a 200 (no write).
- **Timezone is deliberately not editable.** The location's slots were
  generated in it, so changing it would mean regenerating them and deciding
  what happens to booked ones. Chosen with the user: name/address only. A
  wrong timezone therefore still means deleting and recreating the location
  (fine while it has no reservations; `slots` cascade, `reservations` do not).

### Things worth knowing

- **Slots are untouched by an edit.** An e2e test sends a timezone change and
  checks the slots' UTC instants and local times are identical afterwards.
- Since the address is editable, the seeded Orchard / Santa Monica addresses
  (filled in by Claude, never confirmed) can be corrected through the API.

### Verified

- `tsc --noEmit` clean; 84 jest tests; e2e suite 85/85 against the real
  containers (9 new, in `catalog.e2e-spec.ts`): name+address change shows in
  the list, one field alone, timezone and other fields ignored with slots
  unchanged, body with no editable field, three invalid inputs (400),
  non-admin (403) and no token (401), unknown id (404) and malformed id (400).

## Step 18 — Config cleanups (from Step 10's backlog) ✅

Two of the three items under Step 10's "Config cleanups" note.

### What changed

- **Dropped `ConfigModule.forRoot({ isGlobal: true })`** from all three
  `AppModule`s (`apps/api`, `apps/notification-worker`, `apps/event-consumer`).
  Nothing read `@nestjs/config`'s `ConfigService` anywhere (checked — only
  doc-comment mentions of it remained, in `libs/config`, as a shape
  comparison for `AppConfigService`); `@lib/config`'s `AppConfigModule` was
  already doing the real work. Removed the now-unused `@nestjs/config`
  dependency from `package.json` too (`npm uninstall`).
- **`libs/common/src/observability.module.ts`** no longer reads raw
  `process.env.NODE_ENV` in the two spots that picked pino's log level and
  transport. It imports `environmentVariables` from `@lib/config` (the
  already-parsed singleton `environment-variables.ts` exports) instead —
  no DI conversion needed since this file reads the value directly inside a
  static `@Module` decorator array, not through a constructor-injected
  service. No circular import (`@lib/config` doesn't depend on `@lib/common`).
- **Left alone:** splitting the env schema per app. Discussed with the user —
  skipped for now since it's explicitly conditional on the apps ever being
  deployed separately, which isn't the case today; doing it speculatively
  risked a shape that would just be redone once there's a real deployment
  split to design against.

### Verified

- `tsc --noEmit` clean.
- 84 jest tests pass; 85 e2e tests pass against the real containers.
- All three apps rebuilt (`npm run build:all`, webpack) and booted from the
  built bundles — `/health` 200 on all three, no errors in the boot logs.
  Confirmed both `NODE_ENV` branches still work: the plain boot (no
  `NODE_ENV` set) showed pretty-printed (non-JSON) log lines as before: the
  e2e run (`NODE_ENV=test`, jest-set) stayed silent as before.

### Current environment state (as of pausing)

- Containers unchanged and healthy. No app processes left running.
- `package-lock.json` updated by the `@nestjs/config` removal.

## Step 19 — Swagger/OpenAPI docs ✅

Resolves the "Swagger/OpenAPI docs: none" backlog item.

### What changed

- **`@nestjs/swagger@^7.4.2`** (pinned to the v7 line -- v12 needs Nest 12;
  this repo is on Nest 10). `npm install` needed `--legacy-peer-deps`-style
  override (`@nestjs/mapped-types`, pulled in transitively, declares a peer
  range of `class-validator@^0.13.0 || ^0.14.0`; this repo is on `0.15.1`.
  `npm ls` flags it `invalid` but nothing broke -- checked with the full test
  suite and a real boot, below).
- **`nest-cli.json`**: added the `@nestjs/swagger/plugin` CLI plugin
  (`introspectComments: true`) to the root `compilerOptions`. It auto-adds
  `@ApiProperty()` to every class field it can see (DTOs, entities, the new
  response classes below) from the field's real TS type, and pulls
  descriptions straight from this codebase's existing JSDoc comments -- so
  none of the nine request DTOs (`RegisterDto`, `CreateLocationDto`,
  `ListSlotsDto`, etc.) needed a single manual decorator.
- **`apps/api/src/main.ts`**: `SwaggerModule.setup('docs', app, document)`,
  `DocumentBuilder` with `.addBearerAuth()`. Deliberately not in
  `app.setup.ts` (the config shared with the e2e suite) -- it's static
  documentation generation, not request handling, so there's nothing there
  worth exercising on every jest boot. **`/docs` is unauthenticated**, same
  as every `GET` endpoint it describes.
- **`@ApiTags`/`@ApiBearerAuth`/`@ApiOperation`** added to all five
  controllers (`health`, `auth`, `locations`, `slots`, `reservations`).
  `@ApiBearerAuth()` is class-level on the three that are entirely behind
  `JwtAuthGuard`; `auth`/`health` carry neither, matching their actual guard
  setup -- confirmed in the generated document that only those two routes
  have no `security` requirement.
- **Three interfaces became classes, purely so they also work as OpenAPI
  response schemas** (the plugin only introspects real classes, not
  interfaces -- confirmed by testing: TypeORM entities like `Location` got
  full schemas for free, `ReservationView` as a plain interface got a bare
  `{type: object}`). All three still return plain object literals, never
  constructed instances, so **this changed no runtime behavior**, only the
  compile-time type used for documentation and jest's structural equality
  checks don't care about a return value's actual prototype:
  - `SlotLocalTimes` (`@lib/time`) -- now the single reusable definition of
    the four local-time fields, decorated once.
  - `SlotWithAvailability` (`slot-admin.service.ts`) -- `extends Slot`
    (inherits its ~9 fields for free) plus its own five fields
    (`available` + the four local-time ones, redeclared rather than also
    extending `SlotLocalTimes` since a class can only extend one class).
  - `ReservationView` (`reservation-view.ts`) -- plus two small new classes,
    `ReservationSlotView` (`extends SlotLocalTimes`) and
    `ReservationLocationView`, for its two nested objects.
  - `confirmedAt`/`cancelledAt` (`Date | null`) needed an explicit
    `@ApiProperty({ type: Date, nullable: true })` -- the plugin's
    inference falls back to a bare `object` for a nullable-union field
    without it (found by generating the document and inspecting it, not by
    reading the plugin's source).
- **`AuthResponseDto`** (`{ accessToken: string }`, previously an inline
  return type) and **`GenerateSlotsResponseDto`** (`{ created: number }`,
  `POST /slots/generate`'s response) are new, single-purpose classes for the
  same reason -- an inline object type annotation doesn't resolve to a
  named schema either.

### Things worth knowing

- **`/docs` has no auth**, in an app where every other `GET` is already
  open to any authenticated role and most of the design decisions
  (rate limiting, JWT/ADMIN_PASSWORD placeholders) are already flagged
  elsewhere in this file as pre-production loose ends. Gate it behind
  `NODE_ENV`/an admin check if that ever needs to change.
- **Only `apps/api` has Swagger.** `notification-worker`/`event-consumer`
  have no HTTP surface beyond `/health`, so neither needed the dependency or
  the plugin; `@lib/time`'s new `@nestjs/swagger` import doesn't reach
  either app's bundle since neither currently imports `@lib/time` (checked
  the built bundle sizes -- unchanged).
- The plugin's schema inference is generic over any class reachable from a
  controller return type, decorated or not (TypeORM entities have no
  `@ApiProperty` anywhere and still got full schemas) -- the manual
  `@ApiProperty()` calls added here are for enums (`status`, `cancelReason`
  -- string-literal unions aren't auto-detected as enums), the `Date | null`
  case above, and a few `example` values, not because the plugin needed
  them to find the fields at all.
- **Found live in `/docs`, fixed same day**: `ListSlotsDto.date`'s
  `@Matches(/^\d{4}-\d{2}-\d{2}$/)` regex got stringified straight into the
  OpenAPI `pattern` keyword *with* its enclosing `/../` slashes
  (`"/^\\d{4}-\\d{2}-\\d{2}$/"`), which `pattern` doesn't use. Swagger UI's
  own client-side check then required a literal `/` in the input, so every
  real date (`2026-09-22`) failed in "Try it out" before the request was
  even sent -- the actual endpoint was never broken (`curl` with the same
  value returned `200` throughout). Fixed with an explicit
  `@ApiPropertyOptional({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })` on that one
  field, overriding just the docs-generated pattern; the `@Matches`
  decorator (real, server-side validation) is untouched. The only other
  `@Matches` in the codebase; nowhere else to check for the same issue.
  Added `example` values to `from`/`to` at the same time (full ISO 8601 UTC
  instants, matching `@IsDateString` and the e2e suite's existing usage) --
  they'd been left blank in `/docs`.

### Verified

- `tsc --noEmit` clean; 84 jest tests; 85 e2e tests, all against the real
  containers.
- Generated `/docs-json` and inspected it directly (not just eyeballed
  `/docs`): all 12 routes present with the right `security` requirement
  each; every request DTO and response class resolved to a real `$ref`
  schema with correctly typed fields (including the nested
  `ReservationView.slot`/`.location` and `SlotWithAvailability`'s inherited
  `Slot` fields) -- none fell back to a bare `{type: object}`.
- All three apps rebuilt and booted from the built bundles; `/health` 200 on
  all three, `/docs` 200 on `api`, no errors in any boot log.

### Current environment state (as of pausing)

- Containers unchanged and healthy. No app processes left running.
- `package-lock.json`/`package.json` updated by the `@nestjs/swagger` install.

## Step 20 — Dockerfiles + CI ✅

Resolves the "No CI/CD and no Dockerfiles" backlog item.

### What changed

- **`apps/{api,notification-worker,event-consumer}/Dockerfile`**, one per
  app, each a two-stage `node:20-alpine` build: stage 1 (`npm ci`, copy the
  repo, `nest build <app>`) produces `dist/apps/<app>/main.js`; stage 2 does
  its own `npm ci --omit=dev` and copies in just that one file. **`nest
  build` (webpack) externalizes `node_modules` rather than bundling them**
  (this repo's Gotchas #1 already covers why webpack is used at all, but not
  this side effect of it -- confirmed by checking the built bundle for
  `require("@nestjs...")` calls), so the runtime stage genuinely needs its
  own install, not just the one built file. Built from the repo root (one
  shared `package.json`/`node_modules` for every app + lib in this
  monorepo), e.g. `docker build -f apps/api/Dockerfile .`.
- **Dependencies aren't split per app** (same caveat Step 10 already flagged
  for the env schema) -- all three images install the full production
  dependency set (`npm ci --omit=dev`, 759 packages, ~452MB image each) even
  though, say, `event-consumer` never touches Redis or RabbitMQ. Splitting
  this would need per-app `package.json`s, a bigger restructuring left for
  if/when the apps are ever deployed separately.
- **`.dockerignore`**: excludes `node_modules`, `dist`, `.env*` (keeps
  `.env.example`), `.git`, `.vscode`, `coverage`, and `*.md`.
- **`.github/workflows/ci.yml`**, two jobs, on push to `master` and on every
  PR:
  - `test`: brings up the same four services a developer runs locally
    (`docker compose up -d --wait --wait-timeout 180` -- Compose v2.20+'s
    `--wait` blocks until every healthcheck passes instead of just until
    the containers start, confirmed locally: returns in ~7s once already
    healthy, would block up to 180s cold), then `npx tsc --noEmit`, `npm
    test`, `npm run test:e2e`. Mirrors Step 13's documented local workflow
    exactly -- e2e runs through `ts-jest` against the real services, so
    `npm run build:all` is never needed in this job.
  - `docker-build`: matrix over the three apps, builds each image
    (`docker/build-push-action@v6`, `push: false`) to confirm the
    Dockerfiles keep working -- doesn't touch the four services.
  - Does **not** run the app Docker images themselves against the compose
    services (see below for why that specific combination doesn't work
    here) -- both CI jobs test what's actually being shipped (the
    Dockerfiles build; the app code passes its tests), just not "the built
    image talking to the compose stack" as one combined check.
- **Not done, on purpose (decided with the user before starting)**: the
  three apps are not added as `docker-compose.yml` services. Verified why
  that combination doesn't trivially work, below.
- **Migrations are still a separate, manual step.** No Dockerfile or CI job
  runs `npm run typeorm -- migration:run` against a deployed Postgres --
  same as local dev today (Step 2's "Verified" section).

### Things worth knowing

- **Tried running the built `api` image against the compose services
  directly (joined to the `phastos_reservation_default` network) to prove
  the image boots end-to-end, not just builds.** Postgres, Redis and
  RabbitMQ all connected fine (`TypeOrmModule`/`RedisModule`/
  `RabbitmqModule dependencies initialized`), but Kafka failed
  (`ECONNREFUSED` on `localhost:9092`). Cause: `docker-compose.yml`'s
  `KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://localhost:9092` tells every
  client "reconnect to `localhost:9092`" after the initial handshake --
  correct when the client runs on the host itself (every existing verified
  path: local dev, the e2e suite, this CI's `test` job), but from inside
  *another* container, `localhost` is that container's own loopback, not
  the Kafka container. Not a Dockerfile defect -- it's `docker-compose.yml`
  having only ever been configured for host-based clients. Fixing it for
  real container-to-container use would mean adding a second, network-
  internal listener, which is exactly the scope the "Dockerfiles only, not
  wired into compose" decision (made with the user before this step)
  avoided taking on. Cleaned up the test container/images afterward.
- **Image size (~452MB each)** is mostly the full production
  `node_modules` (`pg`, `typeorm`, `kafkajs`, `amqplib`, `ioredis`, `pino`,
  etc.) needed because webpack externalizes them and they aren't split per
  app. Alpine + a slimmer, per-app dependency set could shrink this
  meaningfully but wasn't attempted -- see the "dependencies aren't split
  per app" note above.
- `NODE_ENV=production` in the runtime stage means `pino-pretty` (a
  `devDependency`, absent from `npm ci --omit=dev`) is never reached --
  `observability.module.ts`'s transport branch already only uses it when
  `NODE_ENV !== 'production'` (Step 18).
- Picked Node 20 (the active LTS, matching `@types/node@^20` already in
  `package.json`) over matching local dev's Node 23, which isn't an LTS
  release.

### Verified

- All three images built successfully from a clean local Docker build
  (`docker build -f apps/<app>/Dockerfile .`), each producing a working
  `main.js` + a correctly populated production `node_modules`.
- `docker compose up -d --wait --wait-timeout 60` against the already-
  running, already-healthy stack returned in ~7s -- confirms the flag/
  timeout behave as the CI job expects, on the Docker Compose version
  installed here (`v2.32.4`, well past the `v2.20` minimum for `--wait`).
- `.github/workflows/ci.yml` parsed as valid YAML.
- The built `api` image's Postgres/Redis/RabbitMQ connections verified live
  (see "Things worth knowing" above for the one that didn't, and why).
- Full test suite still green after adding all of the above: `tsc --noEmit`
  clean, 84 unit tests, 85 e2e tests against the real containers.
- **Not verified**: an actual GitHub Actions run (nothing was pushed this
  session) -- the `test` job's steps were each checked to either match an
  already-proven local sequence (Step 13's "How to run") or were run
  directly against Docker on this machine, but the workflow file itself
  hasn't executed on a real runner yet.

### Current environment state (as of pausing)

- Containers unchanged and healthy. No app processes left running.
- No leftover test images/containers from this step's verification.
- Nothing pushed -- `.dockerignore`, the three `Dockerfile`s and
  `.github/workflows/ci.yml` are new, uncommitted files.

## Step 21 — Unit tests for `notification-worker`/`event-consumer`, Node 24, docs reorg ✅

Small follow-ups after Step 20, one commit each.

### What changed

- **Unit tests for the two apps that had none** (`4f51aed`):
  `notification-consumers.service.spec.ts` (retry/DLQ header logic),
  `reminder-sweep.service.spec.ts` (the claim-then-publish race guard) and
  `events-consumer.service.spec.ts` (the `ON CONFLICT DO NOTHING RETURNING`
  dedupe path). Closes the "nothing for `notification-worker` or
  `event-consumer`" gap.
- **Node 20 → 24** in all three Dockerfiles (`node:24-alpine`) and CI's
  `node-version` (`5fa18d3`). Node 20 reached end-of-life; 24 is the Active
  LTS. Supersedes Step 20's "Picked Node 20" note.
- **Docs moved into `docs/`** (`60c6ea4`): `PLAN.md` → `docs/architecture.md`,
  `PROGRESS.md` → `docs/progress.md`, plus `docs/kafka.md` and
  `docs/redis.md`. References in code comments, Dockerfiles and CI updated.
  New root `README.md` with an overview, run/test commands and doc links.
- **Typed the slot hold** in `ReservationsService.create` (`let hold:
  SlotHold`, was an implicit `any`) (`203199a`).

### Verified

- `npm test`: 9 suites, 95 unit tests, all passing (up from 84 in Step 20).
- e2e not re-run for this step; none of the changes touch the api's runtime
  behaviour beyond a type annotation.

### Current environment state (as of pausing)

- `origin/master` is at `5fa18d3`, so the Dockerfiles/CI workflow have been
  pushed and should have triggered a GitHub Actions run, but its result
  hasn't been checked yet (the `gh` CLI isn't installed locally).
  *Later:* checked after Step 23; the `5fa18d3` run passed (see Step 23,
  "Verified").
- `60c6ea4` and `203199a` are local only. Local `master` has no upstream
  tracking branch set. *Later:* pushed along with Steps 22–23.

## Step 22 — `ReservationCancelled` for slot-full confirms ✅

Closes the open decision from Step 13, finding 2: a confirm refused by the
Postgres capacity trigger cancelled the reservation with no reason and no
event, so the Kafka stream showed `ReservationRequested` with nothing after
it.

### What changed

- **New cancel reason `slot_full`** in `ReservationCancelReason`
  (`@lib/domain`), `ReservationCancelledPayload.reason`
  (`@lib/kafka-contracts`), the Swagger enum in `reservation-view.ts`, and
  the schema in `docs/architecture.md` §3. Not accepted from clients:
  `CancelReservationDto` still only allows `user_cancelled`/`admin_cancelled`.
  No migration: `cancel_reason` is a plain `VARCHAR`.
- **`ReservationsService.rejectConfirmIfSlotFull`** now sets
  `cancelReason: 'slot_full'` in its targeted update and publishes
  `ReservationCancelled` (reason `slot_full`). A publish failure is logged
  (`reservation.cancelled_event_publish_failed`) and never changes the 409,
  same as the other lifecycle events.

### Things worth knowing

- **No `SlotReleased` on this path, on purpose.** No capacity comes back:
  Postgres never counted the reservation, and the stale-high Redis counter
  is still left alone (Step 13, finding 2).
- **Only reachable when Redis is wrong.** The Redis claim normally gates
  availability atomically, so a hold that succeeded always fits at confirm.
  This path fires only if the Redis counter is stale or lost; the trigger is
  the backstop against overbooking.

### Verified

- `tsc --noEmit` clean; `npm test`: 95 unit tests passing.
- `npm run test:e2e` against the real containers: 85 tests passing. The
  stale-Redis test (`never confirms more than the capacity when the Redis
  counter is stale, and says 409`) now also checks `cancelReason:
  'slot_full'`, exactly one `ReservationCancelled` with reason `slot_full`,
  and no `SlotReleased`.

### Current environment state (as of pausing)

- Containers up and healthy. No app processes left running.

## Step 23 — Real notification emails via Resend ✅

Ends the "on hold until a mail provider is decided" item: the provider is
**Resend**. All three notification queues (`confirmation-email`,
`reminder`, `receipt`) now send a real email instead of only logging.

### What changed

- **`resend` dependency** (`^6.31.0`) and two new required env vars in
  `@lib/config`: `RESEND_API_KEY` and `EMAIL_FROM`. Added to `.env.example`
  with placeholders (`re_replace_me`, `Phastos <onboarding@resend.dev>`),
  so CI's `cp .env.example .env` still boots.
- **`EmailModule`/`EmailService`**
  (`apps/notification-worker/src/modules/email`): the only code that talks
  to Resend. Resend's SDK returns `{ error }` instead of throwing, so the
  service turns an error into a throw, which the consumer's retry/DLQ path
  then handles.
- **`NotificationSenderService`** (`modules/notifications`): looks the
  recipient up in Postgres by `userId` and loads the reservation with
  `slot.location` by `reservationId`, renders the email for the queue, and
  sends it. The booking details come from that reservation, not the
  payload: payloads don't carry the location's address, and the receipt
  payload has no slot or location at all. Payloads are unchanged.
- **`notification-emails.ts`**: pure renderers (subject, text and HTML) for
  the three emails, with all times on the location's clock. Each email is
  an intro line, then `Reservation ID`, `Location`, `Address` and
  `Date/Time` (local date, start–end, IANA zone). The receipt adds
  `Confirmed at` last. The location
  name is HTML-escaped in the HTML body.
- **`EMAIL_REDIRECT_TO`** (optional, dev only): when set, `EmailService`
  sends every email to that one address instead, with `[Phastos]`
  prefixed to the subject and the intended recipient named in the first
  line of the body. The worker logs `email.redirect_enabled` (warn) on startup
  while it's on. Left commented out in `.env.example`; the local `.env`
  sets it to the Resend account owner's address.
- **`NotificationConsumersService`**: `processMessage` (validate, then only
  log) became `validateMessage`, followed by `sender.send(envelope)`.
  `notification.delivered` now logs Resend's `emailId`.

### Things worth knowing

- **The address is looked up, not put on the queue.** Email addresses never
  sit in RabbitMQ or its DLQs, and a changed address applies to any send
  that hasn't happened yet. An unknown user (or, for a receipt, an unknown
  reservation) throws, so the message retries and then dead-letters.
- **Idempotent retries.** The envelope's `messageId` is sent as Resend's
  `Idempotency-Key`. A retry republishes the same envelope, so if a send
  succeeded but the RabbitMQ ack didn't, Resend answers from the first send
  instead of mailing the user twice. Resend only keeps keys for 24h.
- **`onboarding@resend.dev` only delivers to the Resend account owner's
  address.** Anything else is refused with `validation_error` ("You can
  only send testing emails to your own email address") and dead-letters.
  To email real users: verify a domain at resend.com/domains and point
  `EMAIL_FROM` at it. Until then, `EMAIL_REDIRECT_TO` is how to read the
  emails for any test user. `.local` domains (e.g. `phastos.local`) can never
  be verified, since they can't have public DNS records.
- **The local API key is send-only** (`restricted_api_key`). That is all
  the worker needs; it can't list domains or read anything back.
- **The schema is shared**, so `api` and `event-consumer` also refuse to
  start without `RESEND_API_KEY`/`EMAIL_FROM`, even though they don't use
  them. That's one more reason to split the env schema per app (Step 10's
  backlog).
- **Confirming a reservation sends two emails** (confirmation and receipt),
  because the api publishes to both queues on confirm. That isn't new; it's
  only visible now that the emails are real.

### Verified

- `tsc --noEmit` clean; `npm test`: 11 suites, 104 unit tests passing (up
  from 95). New: `notification-emails.spec.ts` (store-local times for all
  three emails, HTML escaping); `email.service.spec.ts` (Resend call and
  idempotency key, the redirect, Resend errors turned into throws);
  `notification-consumers.service.spec.ts`
  now also covers a failed send scheduling a retry, and a malformed message
  never reaching the sender.
- `nest build notification-worker` succeeds.
- End-to-end against the real containers and Resend: registered the Resend
  account owner's address, then booked and confirmed a Santa Monica slot
  (2026-10-02, 10:00–12:00 America/Los_Angeles) through the api. The worker
  logged `notification.delivered` for both `confirmation-email` and
  `receipt`, each with a Resend `emailId`.
- Redirect, end to end: with `EMAIL_REDIRECT_TO` set to the owner's
  address, registered `alice.redirect-test@example.com` and booked and
  confirmed an Orchard slot (2026-10-05 10:00 Asia/Singapore). Both emails
  were delivered (Resend accepted them) to the owner's inbox instead.
- On startup the worker drained a backlog of about 40 old messages for
  e2e users that no longer exist. Each one failed with "User … not found"
  (or Resend's `validation_error`), was retried, and was dead-lettered after
  3 attempts, which shows the retry/DLQ path works with real failures.
- e2e suite not re-run locally; nothing in `api` changed beyond the two new
  required env vars. It did run in CI (below) and passed.
- **CI on GitHub Actions** (checked through the public REST API, since the
  `gh` CLI isn't installed): every push has passed. That covers `5fa18d3`
  (2026-09-23, the first run, with the Dockerfiles/CI from Step 20),
  `104a734` (2026-09-30) and `275603b` (2026-10-01, this step). In the
  `275603b` run all four jobs passed: typecheck + unit + e2e tests (105s),
  and the `api`, `notification-worker` and `event-consumer` image builds.
  So the api boots on `.env.example`'s placeholder Resend values, and the
  worker image's `npm ci --omit=dev` picks up `resend`.

### Current environment state (as of pausing)

- Containers up. `api` and `notification-worker` were started in the
  background for the end-to-end test. *Later:* both stopped after Step 23.
- The local `.env` has a real (send-only) `RESEND_API_KEY`. `.env` is
  gitignored.
- The local `.env` has `EMAIL_REDIRECT_TO` set, so all emails currently go
  to the Resend account owner.
- The local DB also has `alice.redirect-test@example.com` (same password)
  with a confirmed Orchard reservation for 2026-10-05.
- The local DB has a test user for the Resend account owner's address
  (password `phastos-resend-test`) with a confirmed reservation for
  2026-10-02 17:00Z. With `REMINDER_LEAD_MINUTES=60`, a running worker
  will send a reminder about an hour before.
- The notification DLQs hold the dead-lettered backlog described above.
- Everything is pushed: `origin/master` is at this step's commits, and CI
  passed on them.

## Step 24 — Production compose for one EC2 instance, `start:all` ✅

### What changed

- **`docker-compose.prod.yml`**: the three apps plus self-hosted Postgres,
  Redis, RabbitMQ and Kafka on one host, under its own project name
  (`phastos-prod`) so it never shares volumes with the dev stack. Nothing
  is published on the host except the api (`127.0.0.1:${API_PORT}`) and the
  RabbitMQ admin page (`127.0.0.1:15672`, for an SSH tunnel). Everything is
  `restart: unless-stopped`, with health checks for every service (the apps
  via `wget` against their `/health`). Kafka advertises `kafka:9092` and is
  capped at a 512 MB heap. Redis gets `--appendonly yes`. Container logs
  are capped at 3 × 10 MB per service (Docker keeps them forever by
  default).
- **`migrate` stage in `apps/api/Dockerfile`**: a one-shot image built
  from the `build` stage (it has ts-node, the TypeORM CLI and the `.ts`
  migrations) that runs `migration:run`. In the prod compose file the apps
  only start after it exits successfully. It sits before `runtime`, so a
  plain `docker build` (CI) still produces the runtime image. This closes
  the "migrations are a separate, manual step" note from Step 20.
- **Optional `caddy` service** (`--profile proxy`, `deploy/Caddyfile`):
  HTTPS with automatic Let's Encrypt for `API_DOMAIN`. Left off when the
  host already runs nginx (for example for another app); the runbook has an
  nginx server block for that case.
- **`.env.production.example`**: every variable with production values
  (compose service names as hosts, `CHANGE_ME` for secrets), plus
  `KAFKA_CLUSTER_ID` and `API_DOMAIN`, which only the compose file reads.
  `.gitignore` now ignores `.env.*` except the two example files.
- **`docs/deployment.md`**: runbook covering instance sizing, security
  group, Docker install, configuration, first start (Caddy or existing
  nginx), deploys, backups, day-to-day commands and the limits of this setup.
- **`npm run start:all`** (dev): runs the three apps in watch mode in one
  terminal via `concurrently` (new dev dependency), with each line
  prefixed `[api]`/`[worker]`/`[events]`. In the README.

### Things worth knowing

- **Images are built on the instance** (`up -d --build`). That's simple, but
  it costs a few minutes of the server's CPU and memory per deploy. Next step
  up: CI pushes its images to ECR and the instance pulls them.
- **`POSTGRES_PASSWORD` only applies when the volume is first created**
  (standard `postgres` image behaviour).
- **Never `down -v` on the server**: it deletes the data volumes.
- **Sizing (measured):** about 0.9 GB of memory at idle, so a t3.micro
  (1 GB) doesn't fit; a t3.small (2 GB) is the floor and only with images
  built elsewhere plus swap; t3.medium is the documented minimum. On disk the
  images are ~3.75 GB, so 8 GB isn't enough; 30 GB when building on the
  instance, 16–20 GB if images come from a registry.
- **The admin bootstrap still works in production**, but its two variables
  should be removed from `.env.production` once the admin exists.
- **Domain: `phastos.app`** (Cloudflare Registrar, DNS in Cloudflare).
  `mail.phastos.app` is verified in Resend (CNAME `send.mail`, DKIM
  `resend._domainkey.mail`, DMARC `_dmarc` with `p=none`), and the api will be
  `api.phastos.app`. Both are filled in in `.env.production.example`, and
  the runbook has a DNS section. `.app` is HSTS-preloaded, so the api must
  be served over HTTPS. Checked locally: with
  `EMAIL_FROM=Phastos <no-reply@mail.phastos.app>` and no redirect, Resend
  accepted confirmation and receipt emails for `delivered@resend.dev` (not
  the account owner, refused before verification) and for the owner.

### Verified

- Ran the full production stack locally with a throwaway `.env.production`
  (random secrets, fake Resend key). It built in about 4 minutes, `migrate`
  ran all 6 migrations and exited 0, and all 7 services reported healthy.
  `docker compose ps` showed only `127.0.0.1:3000` and `127.0.0.1:15672`
  published.
- Smoke test through the api: the admin bootstrapped and logged in, created
  a location (its slots were generated), a user registered, held and
  confirmed a slot. `event-consumer` processed `ReservationRequested` and
  `ReservationConfirmed`, and the worker tried both emails, which Resend
  rejected (fake key) and which were retried and then dead-lettered.
- Idle memory for the whole stack: about 0.9 GB (Kafka ~370 MB, RabbitMQ
  ~190 MB, api ~100 MB, the other two apps ~70 MB each, Postgres ~70 MB,
  Redis ~20 MB).
- **Not tested:** the `caddy` service (needs a real domain pointing at a
  real host), and an actual EC2 instance.
- `npm run start:all` started all three apps with prefixed output, and
  Ctrl+C stopped them all. (The dev containers happened to be stopped, so
  the apps couldn't connect to their services during that check.)

### Current environment state (as of pausing)

- The local test stack was removed with `down -v`; the dev volumes are
  untouched. The four built images (`phastos-api`, `-notification-worker`,
  `-event-consumer`, `-migrate`, ~2.3 GB) are kept as build cache.
- No app processes running; the dev containers are stopped.

## Step 25 — Automatic deploys: CI → ECR → Systems Manager ✅

Every push to `master` that passes CI now deploys to the EC2 instance. No
SSH, no open inbound port and no stored keys: GitHub authenticates to AWS
with OIDC, and the instance pulls images with its own role.

### What changed

- **`deploy/aws-setup.yml`** (CloudFormation, one-time): four ECR
  repositories (`phastos-api`, `-notification-worker`, `-event-consumer`,
  `-migrate`, keeping the last 10 images, scan on push); the GitHub OIDC
  provider (optional, since an account can only have one); the
  `phastos-github-deploy` role, which only `master` of this repo can
  assume, and which can only push to those repositories and
  `ssm:SendCommand` to instances tagged `App=phastos`; and the
  `phastos-ec2` instance role/profile (`AmazonSSMManagedInstanceCore` +
  `AmazonEC2ContainerRegistryReadOnly`).
- **`.github/workflows/ci.yml`**:
  - `docker-build` is a 4-image matrix (adds `migrate`). On `master` it
    assumes the role and pushes `phastos-<app>:<commit>` to ECR; on PRs it
    only builds. Buildx GitHub Actions cache per image.
  - New `deploy` job (needs `test` + `docker-build`, `master` only, one at a
    time) runs `deploy/ssm-deploy.sh`.
  - Push and deploy only happen once the repository variable
    `AWS_DEPLOY_ROLE_ARN` is set (plus `AWS_REGION`), so CI behaves exactly
    as before until AWS is set up. `workflow_dispatch` added, to re-run or
    re-deploy by hand.
- **`deploy/ssm-deploy.sh`** (runs in CI): `aws ssm send-command`
  (`AWS-RunShellScript`, target `tag:App=phastos`) running, as `ubuntu`:
  `git fetch && git checkout --detach <commit> && ./deploy/deploy.sh
  <commit>`. Polls until done, prints the output, and fails if the command
  failed or matched no instance.
- **`deploy/deploy.sh`** (runs on the server): ECR login via the instance
  role, `compose pull`, `compose up -d --no-build --remove-orphans --wait`,
  then removes older `phastos-*` images from the registry and records the
  commit in `.env.deployed`. Also the manual way to roll back.
- **`docker-compose.prod.yml`**: app images are
  `${IMAGE_REGISTRY:-local}/phastos-<app>:${IMAGE_TAG:-latest}`; `build:`
  is kept as a fallback.
- **`.env.production.example`**: `IMAGE_REGISTRY` and `COMPOSE_PROFILES`
  (`proxy` by default, replacing `--profile proxy` on the command line).
- **`docs/deployment.md`**: new section 0 (AWS setup), instance profile and
  tag, AWS CLI install, a pipeline-based first start, and section 7
  rewritten (automatic deploys, rollback, building without CI,
  troubleshooting). The `dcp` alias now also reads `.env.deployed`.
  Sizing: the instance no longer builds, so a t3.small (2 GB + swap) and
  20 GB of disk are enough.

### Things worth knowing

- **Image cleanup is scoped.** `deploy.sh` only removes older
  `$IMAGE_REGISTRY/phastos-*` images, never `docker image prune --all`,
  which would also delete another app's images on a shared host. (Caught
  before it shipped.)
- **The commit is checked out before `deploy.sh` runs**, by the SSM command
  itself, so the script and compose file always match the images, and a
  script never rewrites itself while running.
- **`.env.deployed`** keeps hand-run `dcp up -d` on the deployed images
  rather than a `latest` tag that CI never pushes. `--env-file` can be
  repeated, and Compose reads `COMPOSE_PROFILES` from the env file (both
  checked).
- **Rollback** works for the last 10 commits (ECR lifecycle). Migrations
  are never rolled back.

### Verified

- `cfn-lint` clean on `deploy/aws-setup.yml`; `actionlint` (with
  shellcheck) clean on `ci.yml`; `shellcheck` clean on both scripts.
- `deploy.sh` end to end against a local registry (`registry:2` on
  `localhost:5001`, standing in for ECR) with two fake releases:
  - first deploy (`aaaa111`): pulled, `migrate` ran, all healthy, 46s;
  - upgrade (`bbbb222`): apps recreated on the new tag, the `aaaa111`
    images removed, unrelated local images untouched;
  - missing release (`cccc333`): pull fails, exit code 18, `bbbb222` keeps
    running.
  - The `.env.deployed` change came after this run. The env-file
    behaviour it relies on was checked on its own, but the full run wasn't
    repeated.
- **Not tested:** anything on real AWS (the stack, OIDC, ECR push,
  Systems Manager, the instance). That needs the account set up first.

### Current environment state (as of pausing)

- **AWS:** the `phastos-setup` stack (`deploy/aws-setup.yml`) is created in
  `ap-southeast-1` (`CreateGitHubOidcProvider=true`), so the ECR
  repositories, the GitHub deploy role and the `phastos-ec2` instance
  profile exist. **No instance yet:** the new AWS account is blocked from
  launching EC2 until AWS finishes verifying it (support case open).
- **GitHub repository variables not set yet**, on purpose: they're added
  right before the first deploy, so pushes until then only build images
  and never try to deploy to an instance that isn't ready.
- **Production secrets** live in a password manager (Bitwarden), not in
  the repo. `.env.production` will be created on the server from them.
- The local test stack, registry and images were removed; the dev
  containers and the dev api/worker are running.

## Step 26 — Nightly database backups to S3 ✅

### What changed

- **`deploy/aws-setup.yml`**: an S3 bucket `phastos-backups-<account>-<region>`
  (private, SSE-S3, HTTPS-only bucket policy, bucket-owner-enforced,
  `postgres/` expires after `BackupRetentionDays` (default 30), incomplete
  uploads aborted after 1 day). `DeletionPolicy: Retain`, so deleting the
  stack never deletes backups. The instance role gets `s3:PutObject` and
  `s3:GetObject` on `postgres/*`, plus `s3:ListBucket`, but **no delete**.
  New output `BackupBucketName`.
- **`deploy/backup.sh`** (server, nightly from cron): `pg_dump -Fc` to a
  local temp file; uploads only if `pg_dump` succeeded and
  `pg_restore --list` reads it as a dump with tables; then
  `s3://<bucket>/postgres/YYYY/MM/phastos-<UTC time>.dump`. Adds `/snap/bin`
  to `PATH` for cron. Reads `BACKUP_BUCKET` (new in
  `.env.production.example`), and gets the region from `IMAGE_REGISTRY`.
- **`docs/deployment.md`** section 8 rewritten: how it works, the cron line
  (19:00 UTC = 03:00 Singapore), checking it, and a tested restore
  procedure. Section 0: the bucket, the new output, and how to **update** an
  existing stack.

### Things worth knowing

- **`pg_restore --list` is a sanity check, not an integrity check.** It
  only reads the dump's table of contents. What stops a failed dump being
  uploaded is `pg_dump`'s exit status (the script exits on it). The
  comments say exactly that.
- **Bash 3.2 (macOS) vs 5 (Ubuntu):** with `set -u`, an empty array is
  "unbound" in bash 3.2, and the error combined with an `EXIT` trap even
  exits 0 there. Real command failures still exit 1. The script now uses
  `${arr[@]+"${arr[@]}"}`, which works in both. Checked in `bash:5` too.
- **No alerting on a failed backup yet**: cron appends to
  `~/phastos-backup.log`.
- Redis holds/counters aren't in the backup; after a restore they may
  disagree with Postgres until holds expire.

### Verified

- `cfn-lint` clean on the template; `shellcheck` clean on all scripts.
- Against the production stack run locally, with a stand-in `aws` command
  that saved "uploads" to a folder: the backup produced a 20 KB dump with
  the 6 tables. Then the data was damaged (a user and all 88 slots
  deleted), the documented restore run (`pg_restore --clean --if-exists
  --no-owner --exit-on-error`, exit 0), and everything came back: users 2,
  slots 88, migrations 6. The `trg_enforce_slot_capacity` trigger and its
  function are in the dump and present after the restore, the apps came
  back healthy, and the restored user could log in.
- **Not tested:** real S3 and the IAM permissions (needs the stack update
  and the instance), and cron itself.

### Current environment state (as of pausing)

- The `phastos-setup` stack has been **updated** with this template
  (`UPDATE_COMPLETE`): the backup bucket exists (empty until the server's
  first backup) and `BackupBucketName` is in the outputs.
- The local test stack was removed; dev containers and dev apps running.

## Step 27 — Cancellation email, e2e guard against running dev apps ✅

Closes the "Cancellation email" item from "Can wait".

### What changed

- **New `cancellation-email` queue** in `@lib/rabbitmq-contracts`
  (`NotificationQueueName`, `NOTIFICATION_QUEUE_NAMES`,
  `CancellationEmailPayload`: `reservationId`, `userId`, `cancelledAt`,
  `reason: 'user_cancelled' | 'admin_cancelled'`). Both apps declare it at
  startup through `assertNotificationsTopology`, with its own DLQ.
- **api:** `NotificationsPublisherService.publishCancellationEmail`.
  `ReservationsService.cancel` publishes it **only when the reservation was
  `confirmed`**, after the Kafka events. A publish failure is logged
  (`reservation.cancel_notification_publish_failed`) and never fails the
  cancel.
- **notification-worker:** `renderCancellationEmail` (same layout: intro,
  reservation ID, location, address, date/time, then `Cancelled at` in the
  location's time), and the sender handles the new queue. The worker loads
  the booking details from Postgres, as for the other emails.
- `docs/architecture.md` §4 lists the new message.

### Things worth knowing

- **When it's sent:** a confirmed booking cancelled by the user or by an
  admin. **Not** for a hold cancelled before confirming, or for a confirm
  refused because the slot is full: the user was never told they had a
  booking, and the slot-full case is answered immediately with a 409.
- **"Cancelled by our staff" comes from the caller's token, not
  `dto.reason`.** It's an admin cancelling someone else's booking. Found
  along the way: `cancelReason` is client-chosen and not checked against
  the role, so a user can store `admin_cancelled` on their own booking and
  an admin who omits it stores `user_cancelled`. The email ignores it; the
  stored value is unchanged (separate decision, not made here).
- **Order across queues isn't guaranteed.** Each email type has its own
  queue, consumed in parallel; in the live test the cancellation (sent
  milliseconds after confirming) went out before the confirmation. Fine at
  human speed, but a confirmation that fails and is retried later could
  arrive after its cancellation.
- **The e2e suite now refuses to start while a dev `api` or
  `notification-worker` is running** (`test/e2e/dev-apps-guard.ts`, called
  from `global-setup.ts`). It has its own database but shares Redis,
  RabbitMQ and Kafka with the dev apps:
  - a running dev api fails the two hold-expiry tests: both apps' reapers
    get the same Redis expiry event and each returns the spot (expected 1,
    got 2);
  - a running dev worker takes the tests' messages, can't find their users
    in the dev database, and dead-letters them. That's where the 40
    messages in each DLQ came from. It never sends anything, since it
    reads the dev database.
  The guard identifies the apps by their `/health` response (not just an
  open port) and fails within seconds with a message naming them.
  `E2E_ALLOW_RUNNING_APPS=1 npm run test:e2e` skips it for one run; it's
  read before `.env` is loaded, on purpose, so it can't be switched off
  permanently from `.env`. A dev event-consumer is harmless and not
  checked.

### Verified

- `tsc --noEmit` clean. `npm test`: 106 unit tests (2 new: user-cancelled
  and staff-cancelled wording, the exact line order). `npm run test:e2e`:
  86 tests (1 new), with assertions that a confirmed cancel publishes
  exactly one cancellation email (`user_cancelled`), a cancelled hold
  publishes none, a repeated cancel publishes one, an admin cancel says
  `admin_cancelled`, and a user sending `reason: admin_cancelled` still
  gets `user_cancelled`.
- The guard: with the dev api and worker running, `npm run test:e2e`
  stopped after ~4s naming both; with only the api, naming the api; with
  neither, all 86 tests passed.
- Live through real Resend: the owner's address booked, confirmed and
  cancelled (confirmation, receipt, cancellation all delivered), and
  `delivered@resend.dev` booked and confirmed, then an admin cancelled it
  (all delivered).
- The e2e runs' leftover messages were purged from the four main queues
  before the dev worker restarted, so they weren't dead-lettered.

### Current environment state (as of pausing)

- Dev containers and the dev api/worker are running with this change.

## Step 28 — The server records who cancelled ✅

Closes the "Who-cancelled in `cancelReason`" item from "Can wait" (found in
Step 27).

### What changed

- **`POST /reservations/:id/cancel` takes no body.** `cancelReason` is set
  from the caller's token: `admin_cancelled` when an admin cancels someone
  else's reservation, otherwise `user_cancelled`, including an admin
  cancelling their own. `CancelReservationDto` is deleted, and the
  operation's Swagger description says so.
- **Backward compatible:** the global `ValidationPipe` has
  `whitelist: true` (no `forbidNonWhitelisted`), so a `reason` sent by an
  older client is stripped, not rejected. The cancel succeeds and the
  field is ignored.
- The cancellation email now uses the stored `cancelReason` directly
  (Step 27 had worked it out separately from the token).
- The stored value also feeds the Kafka `ReservationCancelled.reason`, so
  downstream consumers now get a trustworthy who-cancelled too.

### Verified

- `tsc --noEmit` clean; 106 unit tests; e2e 87 (1 new). Changed or added:
  a client-sent `reason: hold_expired` is ignored (200, `user_cancelled`;
  it was a 400 before); an admin cancelling someone else's booking with
  no body gets `admin_cancelled`; a user sending `admin_cancelled` gets
  `user_cancelled`, stored and emailed; an admin cancelling their own
  booking gets `user_cancelled`.

## Step 29 — Audit log: `reservation_audit`, written by event-consumer, `GET /audit` ✅

Gives `event-consumer` a real job (it only deduped and logged before).

### What changed

- **Migration `AddReservationAudit1791300000000`** and entity
  `ReservationAudit` (`@lib/database`): one row per Kafka event, with
  `event_id` (PK), `event_type`, `occurred_at`, `slot_id`, `location_id`,
  `reservation_id` and `user_id` (both null for `SlotReleased`),
  `correlation_id`, `payload` (JSONB, as published) and `recorded_at`.
  Indexed by reservation, user and slot, each with `occurred_at` (partial
  indexes for the nullable two). No foreign keys, on purpose: history
  outlives what it describes.
- **event-consumer** (`EventsConsumerService`): the `processed_events`
  claim and the audit insert now run **in one transaction**, so an event is
  recorded exactly once: never claimed-but-unrecorded after a crash, never
  twice on redelivery.
- **api: `GET /audit`, admin only** (`AuditModule`). Filters
  `reservationId` / `userId` / `slotId` (at least one is required; combined,
  an entry must match all of them), `from` (inclusive) / `to` (exclusive)
  as ISO 8601, `limit` (default 100, max 500). Oldest first; page forward by
  passing the last `occurredAt` as `from`.
- Decisions taken (easy to extend later): admins only, no per-user history
  endpoint; kept forever, no retention job.

### Things worth knowing

- **Only events from now on.** Nothing is backfilled. Kafka keeps 7 days by
  default, so older history can't be replayed.
- **Eventually consistent:** a change appears once event-consumer has read
  it from Kafka. In the live check everything was recorded within the 3
  seconds before the history was read; the exact delay wasn't measured.
- **The e2e suite doesn't run event-consumer**, so `audit.e2e-spec.ts`
  inserts rows directly and tests the endpoint; the writing side is
  covered by event-consumer's unit tests and the live check below.
- **Deploying it:** nothing extra. `migrate` applies the migration before
  the apps start, and event-consumer is already in the production stack.

### Verified

- `tsc --noEmit` clean. Unit: 107 (event-consumer's spec rewritten: one
  transaction, the audit row's exact values, `SlotReleased` with null
  reservation/user, no audit row for a duplicate). e2e: 94 (7 new in
  `audit.e2e-spec.ts`: 401/403 for non-admins, 400 without a filter or
  with a malformed one, one reservation's history oldest first, slot filter
  including `SlotReleased`, combined filters, `limit` and `from`/`to`).
- Live, on the dev stack with the real event-consumer: hold → confirm →
  admin cancel, then `GET /audit?reservationId=…` returned
  `ReservationRequested`, `ReservationConfirmed`, `ReservationCancelled`
  (`admin_cancelled`) in order; `?slotId=…` added `SlotReleased`
  (reservation null); a normal user got 403.

### Current environment state (as of pausing)

- The dev database has the new migration applied. Dev api,
  notification-worker and event-consumer are running.

## Step 30 — Switch deploys to DigitalOcean: GHCR images, SSH deploys, R2 backups ✅

The AWS account is still blocked from launching EC2 (Step 25), so the
server moves to a DigitalOcean Droplet. The compose file, Caddy, migrations
and runbook steps are unchanged; only the registry, the deploy channel and
the backup store differ.

### What changed

- **CI** (`.github/workflows/ci.yml`): images go to **GitHub Container
  Registry**, `ghcr.io/<owner>/phastos-<app>:<commit>`, pushed on every
  `master` run with the workflow's own `GITHUB_TOKEN` (`packages: write`);
  nothing to set up. The ECR/OIDC steps are gone. The **Deploy** job runs
  only once the `DEPLOY_HOST` variable exists, and SSHes to
  `DEPLOY_USER@DEPLOY_HOST` with secrets `DEPLOY_SSH_KEY` and
  `DEPLOY_KNOWN_HOSTS` (strict host key checking), sending
  `deploy <commit>` with the job's user and token on stdin
  (`packages: read`).
- **`deploy/ssh-entry.sh`** (new, server): the deploy key's forced command
  (`authorized_keys` `command=...,no-pty,no-port-forwarding,...`). It
  accepts only `deploy <40-hex commit>`, reads the two stdin lines, does
  `git fetch` + `git checkout --detach`, then execs `deploy.sh`.
- **`deploy/deploy.sh`**: logs in to ghcr.io when `GHCR_TOKEN` is given,
  pulls, then **logs out** right away (the CI token expires with the job,
  and a saved expired token would break later pulls).
- **`deploy/backup.sh`**: reads an optional **`.env.backup`** (bucket,
  `BACKUP_S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`) and
  uploads with `--endpoint-url … --region auto` for **Cloudflare R2**.
  Kept apart from `.env.production` so the keys never reach the app
  containers. The AWS path (bucket from `.env.production`, region from
  `IMAGE_REGISTRY`) still works. The temp file name is now portable
  (`mktemp` only randomises trailing X's on macOS).
- **Templates:** `.env.production.example` now defaults to
  `IMAGE_REGISTRY=ghcr.io/choorhong` with `BACKUP_BUCKET` commented out;
  new `deploy/env.backup.example`.
- **`docs/deployment-digitalocean.md`** (new): Droplet, firewall, free
  DigitalOcean alerts (disk, memory, CPU), DNS, server setup with a
  `deploy` user, the restricted CI deploy key and the GitHub
  secrets/variables, first deploy, GHCR visibility, R2 backups and restore,
  rollback, troubleshooting. `docs/deployment.md` now says at the top that
  CI deploys to DigitalOcean and how to bring the AWS path back (the CI
  steps from `31ee695`). README links both.

### Things worth knowing

- **Port 22 is open to everyone**, since GitHub's runners have no fixed
  addresses. Mitigated by key-only logins, and the CI key's forced command
  (no shell, no forwarding, one validated command).
- **The deploy key can deploy any commit that exists on `origin`**, not
  only `master`'s latest. Only CI holds it, and it always sends its own
  `$GITHUB_SHA`.
- **GHCR packages start private.** Deploys work anyway (the job token
  reads them); hand-run pulls on the server need the packages made public
  or a `read:packages` token.
- **R2 tokens that write can also delete**, unlike the AWS instance role
  (Step 26). R2 bucket lock rules can add that protection.
- The AWS stack (`phastos-setup`) is left in place; it costs close to
  nothing unused.

### Verified

- `actionlint` (with shellcheck) clean on `ci.yml`; `shellcheck` clean on
  all scripts.
- `ssh-entry.sh` in a throwaway clone with a stand-in `deploy.sh`: an empty
  command, an arbitrary command, `deploy <sha>; rm -rf ~` and a short hash
  are all refused (exit 2); a valid request checks out the commit and
  passes the stdin user and token through, and works with empty stdin; an
  unknown commit fails at checkout (exit 128).
- `backup.sh` with stand-in `docker` and `aws`: with `.env.backup` it calls
  `aws s3 cp --endpoint-url https://….r2.cloudflarestorage.com --region auto`
  with the keys from the file; with no bucket anywhere it exits 1.
- **Not tested:** the real GHCR push (first `master` run after this
  commit), the SSH deploy against a real Droplet, and real R2 uploads.

### Current environment state (as of pausing)

- Droplet `phastos` created (SGP1, Ubuntu 24.04); SSH answers, ports 80/443
  and the internal ports don't (nothing deployed yet). Server setup, DNS
  record, deploy key and GitHub secrets/variables not done yet.

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

7. **`TimeoutNegativeWarning` on every start of `api` and `event-consumer`.**
   `(node) TimeoutNegativeWarning: -17898... is a negative number.
   Timeout duration was set to 1.` — it comes from inside `kafkajs@2.2.4`
   (`RequestQueue.scheduleCheckPendingRequests`, `requestQueue/index.js:317`,
   found with `node --trace-warnings`), not from our config or code. The
   value is the negative epoch time, i.e. a timer computed against an unset
   value; Node clamps it to 1 ms, so it is harmless. Only the two apps that
   use Kafka show it. Not fixed.

## Next step: launch on DigitalOcean

**Suggested order:**

1. **Launch on DigitalOcean** (`docs/deployment-digitalocean.md`): Droplet,
   firewall and alerts, the `api` DNS record, server setup, the CI deploy
   key and GitHub secrets/variables, first deploy, then R2 backups and the
   cron.
2. **Logs off the server and error alerts.** DigitalOcean's alerts cover
   disk, memory and CPU, but container logs only live on the Droplet
   (capped at 30 MB per service), and nothing alerts when emails start
   dead-lettering or a backup fails. Options: a hosted log service, or
   Docker's log driver to one.

**Can wait** (none of these block the work above):

- **Email polish** (Step 23): the emails are plain one-paragraph-per-line
  text and HTML with no branding, and there is no unsubscribe or
  notification preference. The DLQs have no alerting or replay tooling yet.
- **Audit log extensions** (Step 29): a per-user `GET /reservations/:id/history`,
  and a retention job if the table ever needs trimming.
- **Rate limiting** beyond DTO validation: none.
- **Config cleanups** (Step 10, "Things worth knowing"): two of the three
  done in Step 18 (dropped `ConfigModule.forRoot()`/`@nestjs/config`, typed
  `NODE_ENV` reads). Splitting the env schema per app is still left, for if
  the apps are ever deployed separately.

All four infrastructure legs, the reservation lifecycle HTTP endpoints, the
locations/slots surface, and JWT auth/authz with two roles are built, and the
e2e suite (Step 13) now verifies the api's reservation flow, auth and slot
generation against the real containers. No payment step is planned — this is
a free appointment-booking system (Apple Genius Bar-style), not a paid
reservation. What's left before this is a real system, beyond the list above:

- `JWT_SECRET`/`ADMIN_PASSWORD` in `.env`/`.env.example` are local-dev
  placeholders (`dev-secret-change-me` / `phastos-admin`) — must be
  overridden with real secrets outside local dev. Since Step 10 the app
  refuses to start if `JWT_SECRET` (or any other required variable) is
  missing, but it cannot tell a placeholder from a real secret, so a
  copied-over placeholder value still passes.
- Dockerfiles and a CI workflow exist (Step 20) and pass on GitHub
  Actions (checked in Step 23). Images are only built in CI, never pushed
  to a registry. A production compose file and an EC2 runbook exist
  (Step 24, `docs/deployment.md`), but nothing has been deployed yet.
- Test coverage is the unit tests for the slot/local-time/reservation-view
  logic, `@lib/config`, `notification-worker` (retry/DLQ, reminder sweep) and
  `event-consumer` (dedupe), plus the api e2e suite. There is no e2e suite
  for `notification-worker` or `event-consumer`.

Solid and verified end-to-end:

- Slot-hold concurrency (Redis atomic claim/confirm/release, no double-booking even under a thundering herd)
- Postgres capacity trigger as a hard backstop if Redis is ever bypassed/stale
- Kafka lifecycle events, RabbitMQ notification queues with retry/DLQ, reminder sweep
- Real confirmation/receipt emails via Resend, with the recipient looked up in Postgres and times in store-local time (reminder emails use the same path but haven't been seen arriving yet)
- The reservation endpoints (`POST /reservations`, `/confirm`, `/cancel`, `GET /reservations`, `GET /reservations/:id`), identity-checked against the caller's JWT rather than a client-supplied userId
- Locations/slots endpoints (`POST/GET /locations`, `GET /slots`; slots are generated by rule since Step 11, not posted) — a generated slot is immediately bookable with no manual Redis seeding, and `GET /slots` reports live availability computed against Postgres
- JWT auth with two roles (user/admin): register/login, admin-only location creation and slot generation/capacity edits, and reservation ownership enforced (a user can only confirm/cancel their own booking; admin can act on any)
