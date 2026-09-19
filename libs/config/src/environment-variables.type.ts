/**
 * One property per `.env`/`.env.example` variable, precisely typed --
 * `AppConfigService.get('SOME_TYPO')` is a compile error instead of a
 * silent `undefined` at runtime, and `AppConfigService.get('POSTGRES_PORT')`
 * comes back as `number`, not `string`.
 *
 * Everything with a sensible localhost default (see `environment-variables.ts`)
 * is non-optional here -- the values file guarantees it's always present,
 * so callers never need to handle `undefined` for it. Only vars with no
 * safe default stay optional/required as appropriate:
 *  - `JWT_SECRET` has no safe default (would silently make auth insecure),
 *    so it's required with no fallback -- missing it fails the app at boot.
 *  - `ADMIN_EMAIL`/`ADMIN_PASSWORD` are genuinely optional: unset on
 *    purpose means "skip admin bootstrap" (see `AdminBootstrapService`),
 *    so they must NOT get a default value baked in.
 *  - `NODE_ENV` is whatever the host process sets it to, or unset.
 */
export interface EnvironmentVariables {
  // Postgres
  POSTGRES_HOST: string;
  POSTGRES_PORT: number;
  POSTGRES_USER: string;
  POSTGRES_PASSWORD: string;
  POSTGRES_DB: string;

  // Redis
  REDIS_HOST: string;
  REDIS_PORT: number;
  HOLD_TTL_SECONDS: number;
  HOLD_REAPER_SWEEP_INTERVAL_MS: number;

  // RabbitMQ
  RABBITMQ_HOST: string;
  RABBITMQ_PORT: number;
  RABBITMQ_USER: string;
  RABBITMQ_PASSWORD: string;
  NOTIFICATION_MAX_RETRIES: number;

  // Reminder sweep (notification-worker)
  REMINDER_LEAD_MINUTES: number;
  REMINDER_SWEEP_INTERVAL_MS: number;

  // Kafka
  KAFKA_BROKERS: string;
  KAFKA_CLIENT_ID: string;
  KAFKA_TOPIC_REPLICATION_FACTOR: number;
  EVENT_CONSUMER_GROUP_ID: string;

  // Auth (apps/api/src/modules/auth)
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;

  // apps
  API_PORT: number;
  NOTIFICATION_WORKER_PORT: number;
  EVENT_CONSUMER_PORT: number;

  NODE_ENV?: string;
}
