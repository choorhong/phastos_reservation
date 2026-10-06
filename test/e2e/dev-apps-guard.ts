import { config as loadDotenv } from 'dotenv';

/**
 * The e2e suite has its own database, but shares Redis, RabbitMQ and Kafka
 * with the dev apps. Refuse to start while a dev `api` or
 * `notification-worker` is running, rather than fail confusingly later:
 *
 * - api: its hold reaper reacts to the same Redis expiry events, so an
 *   expired test hold is handed back twice and the hold-expiry tests fail.
 * - notification-worker: it takes the tests' messages off the shared
 *   queues, can't find their users in the dev database, and dead-letters
 *   every one of them.
 *
 * Identified by their `/health` response, so an unrelated process on the
 * same port doesn't trip this.
 *
 * To skip it for one run: `E2E_ALLOW_RUNNING_APPS=1 npm run test:e2e`. It's
 * read before `.env` is loaded, on purpose, so it can't be switched off
 * permanently from `.env`. Skipping doesn't make the hold-expiry tests pass
 * while a dev api is running.
 */
const DEV_APPS = [
  { service: 'api', portVar: 'API_PORT', fallbackPort: 3000 },
  { service: 'notification-worker', portVar: 'NOTIFICATION_WORKER_PORT', fallbackPort: 3001 },
] as const;

export async function assertNoDevAppsRunning(): Promise<void> {
  if (process.env.E2E_ALLOW_RUNNING_APPS === '1') {
    return;
  }
  loadDotenv();

  const running: string[] = [];
  for (const app of DEV_APPS) {
    const port = Number(process.env[app.portVar] ?? app.fallbackPort);
    if (await answersAs(port, app.service)) {
      running.push(`${app.service} (port ${port})`);
    }
  }
  if (running.length > 0) {
    throw new Error(
      `Dev app(s) running: ${running.join(', ')}. Stop them before running the e2e suite: ` +
        'it shares Redis/RabbitMQ/Kafka with them, and a running api makes the hold-expiry ' +
        'tests fail. (To run anyway, for this run only: E2E_ALLOW_RUNNING_APPS=1 npm run test:e2e)',
    );
  }
}

async function answersAs(port: number, service: string): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    const body = (await res.json()) as { service?: unknown };
    return body.service === service;
  } catch {
    return false; // nothing listening, not JSON, or too slow: not our app
  }
}
