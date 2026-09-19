import { config as loadDotenv } from 'dotenv';
import type { EnvironmentVariables } from './environment-variables.type';

// Loaded here directly (not just via @nestjs/config's ConfigModule.forRoot())
// so this file is correct regardless of Nest's module-import order -- this
// module's top-level code can run before ConfigModule.forRoot() does (ES
// imports resolve before the importing file's own decorator/statements
// run). dotenv.config() is safe to call more than once.
loadDotenv();

function toNumber(name: string, raw: string | undefined, defaultValue: number): number {
  if (raw === undefined || raw === '') {
    return defaultValue;
  }
  const value = Number(raw);
  if (Number.isNaN(value)) {
    throw new Error(`Invalid environment variable ${name}: expected a number, got "${raw}"`);
  }
  return value;
}

function required(name: string, raw: string | undefined): string {
  if (!raw) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return raw;
}

/**
 * The single source of truth for every env var this app reads, computed
 * once at import time (fail-fast: a malformed/missing required value
 * throws here, before the app accepts any request). Values always come
 * from `process.env` -- never hardcoded -- so production secrets can live
 * entirely outside this repo: a separate, devops-owned store/repo
 * populates `process.env` before the process starts in production, while
 * local dev keeps using the `.env` file via `loadDotenv()` above. This
 * file doesn't know or care which one it is.
 */
export const environmentVariables: EnvironmentVariables = {
  // Postgres
  POSTGRES_HOST: process.env.POSTGRES_HOST ?? 'localhost',
  POSTGRES_PORT: toNumber('POSTGRES_PORT', process.env.POSTGRES_PORT, 5432),
  POSTGRES_USER: process.env.POSTGRES_USER ?? 'phastos',
  POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD ?? 'phastos',
  POSTGRES_DB: process.env.POSTGRES_DB ?? 'phastos_reservation',

  // Redis
  REDIS_HOST: process.env.REDIS_HOST ?? 'localhost',
  REDIS_PORT: toNumber('REDIS_PORT', process.env.REDIS_PORT, 6379),
  HOLD_TTL_SECONDS: toNumber('HOLD_TTL_SECONDS', process.env.HOLD_TTL_SECONDS, 300),
  HOLD_REAPER_SWEEP_INTERVAL_MS: toNumber(
    'HOLD_REAPER_SWEEP_INTERVAL_MS',
    process.env.HOLD_REAPER_SWEEP_INTERVAL_MS,
    30_000,
  ),

  // RabbitMQ
  RABBITMQ_HOST: process.env.RABBITMQ_HOST ?? 'localhost',
  RABBITMQ_PORT: toNumber('RABBITMQ_PORT', process.env.RABBITMQ_PORT, 5672),
  RABBITMQ_USER: process.env.RABBITMQ_USER ?? 'guest',
  RABBITMQ_PASSWORD: process.env.RABBITMQ_PASSWORD ?? 'guest',
  NOTIFICATION_MAX_RETRIES: toNumber('NOTIFICATION_MAX_RETRIES', process.env.NOTIFICATION_MAX_RETRIES, 3),

  // Reminder sweep (notification-worker)
  REMINDER_LEAD_MINUTES: toNumber('REMINDER_LEAD_MINUTES', process.env.REMINDER_LEAD_MINUTES, 60),
  REMINDER_SWEEP_INTERVAL_MS: toNumber('REMINDER_SWEEP_INTERVAL_MS', process.env.REMINDER_SWEEP_INTERVAL_MS, 60_000),

  // Kafka
  KAFKA_BROKERS: process.env.KAFKA_BROKERS ?? 'localhost:9092',
  KAFKA_CLIENT_ID: process.env.KAFKA_CLIENT_ID ?? 'phastos-reservation',
  KAFKA_TOPIC_REPLICATION_FACTOR: toNumber(
    'KAFKA_TOPIC_REPLICATION_FACTOR',
    process.env.KAFKA_TOPIC_REPLICATION_FACTOR,
    1,
  ),
  EVENT_CONSUMER_GROUP_ID: process.env.EVENT_CONSUMER_GROUP_ID ?? 'event-consumer',

  // Auth
  JWT_SECRET: required('JWT_SECRET', process.env.JWT_SECRET),
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN ?? '1h',
  ADMIN_EMAIL: process.env.ADMIN_EMAIL,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,

  // apps
  API_PORT: toNumber('API_PORT', process.env.API_PORT, 3000),
  NOTIFICATION_WORKER_PORT: toNumber('NOTIFICATION_WORKER_PORT', process.env.NOTIFICATION_WORKER_PORT, 3001),
  EVENT_CONSUMER_PORT: toNumber('EVENT_CONSUMER_PORT', process.env.EVENT_CONSUMER_PORT, 3002),

  NODE_ENV: process.env.NODE_ENV,
};
