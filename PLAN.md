# Phastos Reservation System — Architecture Plan

A slot-booking system (Apple Store-style Genius Bar / pickup appointments):
location + date + time-slot selection over limited capacity, correct under
thundering-herd concurrency, no double-booking.

---

## 1. Module / Folder Structure

### Recommendation: **Nest monorepo — modular monolith at the domain level, multiple deployables at the process level**

Not a single monolith process, and not full microservices from day 1. Use
Nest's monorepo mode (or Nx) with `apps/` (independently deployable
processes) and `libs/` (shared, versioned-together code). Domain logic lives
in one codebase with enforced module boundaries; only the pieces with a
genuinely different scaling/failure profile become separate processes.

```
phastos-reservation/
├── apps/
│   ├── api/                        # HTTP API — the synchronous booking path
│   │   └── src/
│   │       ├── modules/
│   │       │   ├── locations/
│   │       │   ├── slots/              # slot CRUD, capacity admin
│   │       │   ├── reservations/       # claim/confirm/cancel — the hot path
│   │       │   │   ├── reservations.controller.ts
│   │       │   │   ├── reservations.service.ts
│   │       │   │   ├── redis-hold.service.ts   # wraps Lua scripts
│   │       │   │   └── reservations.repository.ts
│   │       │   └── health/
│   │       └── main.ts
│   │
│   ├── notification-worker/        # RabbitMQ consumers only
│   │   └── src/
│   │       ├── consumers/
│   │       │   ├── send-confirmation-email.consumer.ts
│   │       │   ├── send-reminder.consumer.ts
│   │       │   └── generate-receipt.consumer.ts
│   │       └── main.ts
│   │
│   └── event-consumer/             # Kafka consumers only
│       └── src/
│           ├── consumers/
│           │   ├── analytics.consumer.ts
│           │   ├── audit-log.consumer.ts
│           │   └── inventory-sync.consumer.ts
│           └── main.ts
│
├── libs/
│   ├── domain/                     # entities, DTOs, value objects (shared types)
│   ├── kafka-contracts/            # event envelope + payload TS interfaces (§3)
│   ├── redis-scripts/              # .lua files + typed wrappers (§2)
│   ├── database/                   # TypeORM entities, migrations, data source config
│   ├── rabbitmq-contracts/         # queue message DTOs
│   └── common/                     # logging (pino), config module, tracing, health
│
├── docker-compose.yml
└── PLAN.md
```

**Why not pure microservices (separate repos/deploys per bounded context)?**

| | Modular monolith w/ split deployables (recommended) | Full microservices |
|---|---|---|
| Deployment complexity | Low–medium: 3 processes, 1 repo, shared CI | High: independent repos/pipelines, service discovery, distributed tracing mandatory |
| Consistency | Easy to share TS types for events/DTOs across processes (same repo) | Needs published contract packages or schema registry from day 1 |
| Scaling | api / notification-worker / event-consumer scale independently already — that's the axis that actually matters here | Same capability, more infra to get it |
| Team size fit | Good for a small-to-mid team | Pays off mainly with multiple independent teams |
| Path to microservices later | `reservations` module is already isolated behind a service interface — easy to cut out into its own deployable when it outgrows the monolith | N/A, already there |

The reason to split `api`, `notification-worker`, and `event-consumer` into
**separate processes** (even inside one repo) rather than one Nest app: they
have different scaling triggers (API scales on request QPS, notification
worker scales on RabbitMQ queue depth, event consumer scales on Kafka lag)
and different failure blast radii (a slow email provider must never back
up the booking API's event loop). This is the one place blurring the roles
would hurt, so it's split even though everything else stays monolithic.

---

## 2. Redis Slot-Hold Algorithm

### Data structures

| Key | Type | Purpose |
|---|---|---|
| `slot:{slotId}:available` | String (int) | Remaining capacity. Source-of-truth-in-cache, seeded from Postgres. |
| `hold:{slotId}:{holdId}` | String, value = `userId`, `TTL=HOLD_TTL` (300s) | The reservation hold itself. TTL is what makes it "expire" a hold automatically. |
| `slot:{slotId}:pending` | Sorted Set, member=`holdId`, score=`expiresAtEpochMs` | Index of live holds per slot, for observability + a reconciliation fallback (TTL expiry alone is not queryable). |

Key naming uses `{slotId}` as a **hash tag** so all three keys for a slot
land on the same Redis Cluster slot — required for the Lua script (and
any future `MULTI`) to be atomic across them in a clustered deployment.

### Claim (Lua script — one round trip, atomic)

```lua
-- KEYS[1] = slot:{slotId}:available
-- KEYS[2] = hold:{slotId}:{holdId}
-- KEYS[3] = slot:{slotId}:pending
-- ARGV[1] = holdId, ARGV[2] = userId, ARGV[3] = holdTtlSeconds, ARGV[4] = nowMs

local available = tonumber(redis.call('GET', KEYS[1]))
if available == nil then
  return redis.error_reply('SLOT_NOT_LOADED')   -- cache miss -> app loads from Postgres, retries
end
if available <= 0 then
  return redis.error_reply('SOLD_OUT')
end

redis.call('DECR', KEYS[1])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
redis.call('ZADD', KEYS[3], ARGV[4] + (ARGV[3] * 1000), ARGV[1])

return redis.status_reply('HELD')
```

### Confirm (on checkout complete)

```lua
-- KEYS[1] = hold:{slotId}:{holdId}
-- KEYS[2] = slot:{slotId}:pending
-- ARGV[1] = holdId

local userId = redis.call('GET', KEYS[1])
if not userId then
  return redis.error_reply('HOLD_EXPIRED')   -- app must reject checkout, capacity was already given back
end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return userId   -- capacity stays decremented permanently; caller now writes Postgres row
```

### Release (on explicit cancel, or reaped expiry)

```lua
-- KEYS[1] = slot:{slotId}:available
-- KEYS[2] = hold:{slotId}:{holdId}
-- KEYS[3] = slot:{slotId}:pending
-- ARGV[1] = holdId

if redis.call('EXISTS', KEYS[2]) == 1 then
  redis.call('DEL', KEYS[2])
end
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('INCR', KEYS[1])
```

Passive TTL expiry deletes `hold:{slotId}:{holdId}` on its own but does
**not** touch `available` or `pending` — a reaper is required (see below).

### Reaper (returns capacity from expired-but-unconfirmed holds)

Two layers, because relying on only one is fragile:
1. **Keyspace notifications** (`notify-keyspace-events Ex`): subscribe to
   expired-key events matching `hold:*`, run the Release script. Fast
   (near-real-time), but notifications are fire-and-forget — missed on a
   Redis restart/failover window.
2. **Reconciliation sweep** (every ~30s, one instance via a leader lock or
   a dedicated scheduler): `ZRANGEBYSCORE slot:{slotId}:pending -inf now`
   → for every returned holdId whose `hold:*` key no longer exists, run
   Release. This is the correctness backstop; the keyspace notification is
   just the latency optimization.

Emit a structured log line (`slot.hold.expired_reaped`) with `slotId`,
`holdId`, `reapedBy: "notification" | "sweep"` for observability.

### Concurrency walkthrough: two users claim the last slot at the same millisecond

1. `available = 1`. User A and User B both call `claimSlot(slotId)` at
   effectively the same wall-clock instant, from two different pods.
2. Both requests reach Redis. Redis is single-threaded for command/script
   execution — even under Cluster, both keys hash to the same slot (hash
   tag), so both `EVALSHA` calls are serviced by the *same* Redis node and
   are strictly ordered relative to each other, whichever arrives
   microseconds first.
3. Say A's script runs first: reads `available=1`, decrements to `0`,
   creates `hold:{slotId}:{holdIdA}`, adds to `pending`, returns `HELD`.
4. B's script then runs (already queued, no client-side retry needed):
   reads `available=0`, hits `if available <= 0`, returns `SOLD_OUT`
   *without mutating anything*.
5. A proceeds to checkout with `holdIdA`; B's request fails fast with a
   "slot no longer available" response — no lock contention, no retry
   storm, one round trip each.
6. **Why not `WATCH`/`MULTI`** for this: optimistic locking makes the
   loser *retry* (re-`WATCH`, re-read, re-`MULTI`) rather than fail
   immediately, and under a thundering herd on one hot slot (product
   launch day) that produces a retry storm that gets worse as concurrency
   increases. The Lua script gives the same atomicity in a single
   round-trip with no retry loop — the loser is told "sold out" on the
   first try, deterministically.
7. **Defense in depth**: Postgres is still the source of truth. The
   `reservations` table carries a partial unique constraint (e.g. one row
   per `(slotId, seatNumber)` or an app-level `confirmed` count check
   inside the same transaction as the insert) so that even if Redis were
   ever bypassed, stale, or lost mid-incident, Postgres physically cannot
   accept more confirmed rows than capacity.
8. **Redis crash / cold cache**: `available` is a cache of Postgres truth,
   not the truth itself. On cache miss the script returns `SLOT_NOT_LOADED`;
   the app computes `capacity - COUNT(confirmed reservations)` from
   Postgres and does a `SETNX` before retrying the claim.

---

## 3. Kafka Topic(s), Partition Key, Event Schema

### Topic design: **one topic, multiple event types, partitioned by `slotId`**

`reservation-events` — single topic (not one topic per event type).

**Partition key = `slotId`** (not `locationId`). Rationale: the ordering
guarantee that actually matters is *within a slot's lifecycle*
(`Requested` → `Confirmed`/`Cancelled` → `SlotReleased` must be consumed
in that order by, e.g., inventory-sync). `slotId` as the key guarantees
all of one slot's events land in the same partition, hence in order.
`locationId` would guarantee per-location ordering instead, but a busy
location (flagship store on launch day) has many independent slots, so
keying by `locationId` concentrates hot-slot traffic onto one partition —
exactly the hotspot a thundering-herd scenario creates. If a downstream
consumer later needs per-location aggregate ordering, it can re-key via a
Kafka Streams repartition step rather than sacrificing slot-level order
in the primary topic.

Splitting into 4 topics (`reservation.requested`, `.confirmed`,
`.cancelled`, `slot.released`) was considered — it gives consumers
subscribe-by-type granularity — but Kafka guarantees order only *within*
a partition of *one* topic. Four independent topics, even keyed
identically, don't guarantee `Confirmed` is consumed after `Requested`
relative to each other. Single topic wins here because slot-lifecycle
ordering is a hard correctness requirement for inventory-sync.

Config: `partitions: 12` (headroom to scale event-consumer instances
independently of Redis/Postgres sharding), `replication.factor: 3` in
non-local envs, `cleanup.policy=delete`, retention long enough for
audit/replay needs (e.g. 30–90 days) — this is the durable log, not just
a message bus.

### Event schema (TypeScript)

```ts
// libs/kafka-contracts/src/reservation-events.ts

export type ReservationEventType =
  | 'ReservationRequested'
  | 'ReservationConfirmed'
  | 'ReservationCancelled'
  | 'SlotReleased';

interface EventEnvelope<T extends ReservationEventType, P> {
  eventId: string;         // UUID v4 — dedupe key for idempotent consumers
  eventType: T;
  occurredAt: string;      // ISO 8601, set at the moment the fact became true
  version: 1;
  slotId: string;          // == Kafka partition key
  locationId: string;
  correlationId: string;   // ties back to the originating HTTP request / hold
  payload: P;
}

export interface ReservationRequestedPayload {
  reservationId: string;
  userId: string;
  holdId: string;
  requestedAt: string;
}

export interface ReservationConfirmedPayload {
  reservationId: string;
  userId: string;
  confirmedAt: string;
  slotStartTime: string;
  slotEndTime: string;
}

export interface ReservationCancelledPayload {
  reservationId: string;
  userId: string;
  cancelledAt: string;
  reason: 'user_cancelled' | 'hold_expired' | 'admin_cancelled' | 'payment_failed';
}

export interface SlotReleasedPayload {
  slotId: string;
  releasedCapacity: number;
  reason: 'cancellation' | 'hold_expired' | 'capacity_adjustment';
}

export type ReservationEvent =
  | EventEnvelope<'ReservationRequested', ReservationRequestedPayload>
  | EventEnvelope<'ReservationConfirmed', ReservationConfirmedPayload>
  | EventEnvelope<'ReservationCancelled', ReservationCancelledPayload>
  | EventEnvelope<'SlotReleased', SlotReleasedPayload>;
```

### Idempotent consumption

Every consumer (analytics, audit, inventory-sync) keeps a small
`processed_events(event_id PRIMARY KEY, consumer_name, processed_at)`
table (or a Redis `SETNX processed:{consumer}:{eventId}` with a
retention TTL longer than max expected redelivery window) and checks it
**before** applying side effects, inside the same DB transaction as the
side effect where the consumer writes to Postgres. `eventId` (UUID,
produced once at publish time and never regenerated on retry) is the
dedupe key — this is what makes "consumers may receive duplicate events"
safe.

---

## 4. RabbitMQ vs Direct Calls

**Rule of thumb:** if the caller needs the result synchronously to
respond to the user → direct call (in-process service call inside `api`,
or HTTP/gRPC if it ever crosses a process boundary). If it's a side
effect that can happen slightly later and needs retry/backoff/DLQ instead
of blocking the request → RabbitMQ.

| Concern | Mechanism | Why |
|---|---|---|
| Claim a slot hold | Direct (in-process, → Redis) | User is waiting on the response; must be sub-100ms |
| Confirm reservation (checkout) | Direct (in-process, → Postgres tx) | Same — result gates what the user sees next |
| Publish lifecycle event | Direct producer call (→ Kafka) from within the request path | Fire-and-forget to the log, but the produce call itself is fast (no external dependency, no retry policy needed beyond Kafka's own) |
| Confirmation email | **RabbitMQ** (`notification-worker`) | Slow/unreliable third-party (SendGrid/SES); needs retry + DLQ; must never block checkout |
| Reminder notification (e.g. T-1hr before appointment) | **RabbitMQ**, published via a delayed-message plugin or a scheduler that enqueues at the right time | Same — external delivery, needs retry |
| Receipt/PDF generation | **RabbitMQ** | CPU/IO-bound side task, retryable, not needed to answer the user |
| Analytics / audit / inventory-sync | Kafka consumers (not RabbitMQ) | These are durable-log readers of the event stream, not task-queue workers — they replay history, don't need per-message retry/DLQ semantics the same way |

Each RabbitMQ queue gets a matching DLQ (`x-dead-letter-exchange`) with a
retry-count header; after N retries move to DLQ and alert rather than
loop forever.

---

## 5. docker-compose Services (local dev)

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: phastos_reservation
      POSTGRES_USER: phastos
      POSTGRES_PASSWORD: phastos
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]

  redis:
    image: redis:7
    command: ["redis-server", "--notify-keyspace-events", "Ex"]
    ports: ["6379:6379"]

  rabbitmq:
    image: rabbitmq:3-management
    ports: ["5672:5672", "15672:15672"]   # 15672 = management UI

  kafka:
    image: confluentinc/cp-kafka:7.6.0     # KRaft mode, no Zookeeper needed
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_LISTENERS: PLAINTEXT://:9092,CONTROLLER://:9093
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://localhost:9092
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:9093
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
    ports: ["9092:9092"]

  kafka-ui:
    image: provectuslabs/kafka-ui:latest    # topic/partition/consumer-lag inspection
    environment:
      KAFKA_CLUSTERS_0_BOOTSTRAPSERVERS: kafka:9092
    ports: ["8080:8080"]
    depends_on: [kafka]

  redis-commander:
    image: rediscommander/redis-commander   # inspect hold keys / TTLs while debugging
    environment:
      REDIS_HOSTS: local:redis:6379
    ports: ["8081:8081"]
    depends_on: [redis]

volumes:
  pgdata:
```

`api`, `notification-worker`, and `event-consumer` are intentionally
**not** containerized in this file — run via `nest start --watch` per app
during development for fast iteration; add them to compose only for an
integration-test profile later if needed.

---

## Decisions

1. **ORM: TypeORM.** Most Nest-idiomatic option (`@nestjs/typeorm`,
   decorator-based entities), which keeps `libs/database` consistent with
   the rest of the Nest-conventions codebase. Reservation-confirm writes
   use TypeORM's `QueryRunner`-based transactions (`manager.transaction()`)
   so the capacity check + insert stay atomic; the Postgres unique
   constraint remains the hard backstop regardless of ORM.

2. **Reminder scheduling: DB scheduler sweep → RabbitMQ.** A cron job
   (`@nestjs/schedule`, running in `notification-worker`) periodically
   queries `reservations` for rows whose reminder is due in the next
   window and enqueues each to RabbitMQ only at delivery time — not the
   `rabbitmq-delayed-message-exchange` plugin. Reminders are hours-to-a-day
   out (a long, variable delay unsuited to holding messages in a queue),
   and the sweep naturally skips reservations that were cancelled in the
   meantime, since they no longer match the query. RabbitMQ's own
   TTL+DLQ mechanics are still used for short retry backoff on message
   processing failures (seconds–minutes), which is a different problem.

3. **Observability: wired in from day 1.** Baseline structured logging
   (`pino` via `nestjs-pino`) and request-scoped `correlationId`
   propagation (`nestjs-cls`) are part of the initial scaffold, threaded
   through the HTTP request → Redis hold → Kafka publish → RabbitMQ
   enqueue chain from the start, rather than retrofitted later. Full
   OpenTelemetry span export (Jaeger/Tempo backend) can be layered on
   afterward without changing this plumbing. This directly serves the
   stated non-functional requirement ("structured logging around slot
   claim/release and queue depth").
