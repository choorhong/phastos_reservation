/**
 * Environment for the e2e run. Loaded before anything reads config (jest
 * `setupFiles`, and first import of `setup-db.ts`): `@lib/config` loads
 * `.env` with dotenv, which never overrides a variable that is already set,
 * so everything here wins over `.env`. Everything not set here (hosts,
 * ports, credentials, JWT secret...) still comes from `.env`, so copy
 * `.env.example` to `.env` first.
 */

/** A separate database, so tests never touch (or get confused by) dev data. */
export const E2E_DATABASE = 'phastos_reservation_test';

export const E2E_ADMIN = { email: 'e2e-admin@test.local', password: 'e2e-admin-password' };

/** Short enough that the hold-expiry tests don't take long. */
export const HOLD_TTL_MS = 3000;

Object.assign(process.env, {
  POSTGRES_DB: E2E_DATABASE,
  ADMIN_EMAIL: E2E_ADMIN.email,
  ADMIN_PASSWORD: E2E_ADMIN.password,
  HOLD_TTL_SECONDS: String(HOLD_TTL_MS / 1000),
  // Pinned so the tests don't depend on whatever the dev .env says.
  SLOT_OPEN_HOUR: '10',
  SLOT_CLOSE_HOUR: '18',
  SLOT_DURATION_HOURS: '2',
  SLOT_CAPACITY: '3',
  SLOT_WINDOW_DAYS: '30',
});

// KafkaJS prints a one-off notice about its default partitioner on every boot.
process.env.KAFKAJS_NO_PARTITIONER_WARNING = '1';

// Logs are silenced under NODE_ENV=test; E2E_LOGS=1 turns them back on.
if (process.env.E2E_LOGS) {
  process.env.NODE_ENV = 'development';
}
