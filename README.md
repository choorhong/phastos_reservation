# Phastos Reservation

A slot-booking system (Genius Bar / pickup-appointment style): pick a
location, date and time slot with limited capacity — correct under
thundering-herd concurrency, with no double-booking.

NestJS monorepo with three deployables:

| App                        | Role                                                            |
| -------------------------- | --------------------------------------------------------------- |
| `apps/api`                 | HTTP API — auth, locations, slots, reservation hold/confirm/cancel |
| `apps/notification-worker` | RabbitMQ consumers — confirmation emails, reminders             |
| `apps/event-consumer`      | Kafka consumer for reservation lifecycle events                 |

Shared code lives in `libs/` (database entities and migrations, Redis Lua
scripts, Kafka/RabbitMQ contracts, config, common).

## Running locally

```bash
cp .env.example .env
docker compose up -d          # Postgres, Redis, RabbitMQ, Kafka (+ kafka-ui)
npm install
npm run typeorm -- migration:run -d libs/database/src/data-source.ts

npm run start:all                     # all three apps in one terminal; Ctrl+C stops them all

# or one app per terminal:
npm run start:api                     # http://localhost:3000, Swagger at /docs
npm run start:notification-worker
npm run start:event-consumer
```

All of these run in watch mode, so an app restarts by itself when its code
changes. In `start:all` each line is prefixed with the app it came from
(`[api]`, `[worker]`, `[events]`).

## Tests

```bash
npm test                      # unit tests
npm run test:e2e              # boots the real api against docker-compose services
```

## Docs

- [Architecture](docs/architecture.md): module layout, Redis hold algorithm,
  Kafka event design, RabbitMQ usage, and the design decisions
- [Redis hold flow](docs/redis.md): keys and the claim/confirm/release lifecycle
- [Kafka event design](docs/kafka.md): topic, partitioning and event types
- [Deployment](docs/deployment.md): running everything on one EC2 instance
  with `docker-compose.prod.yml`
- [Progress log](docs/progress.md): step-by-step build log, gotchas and how-tos
