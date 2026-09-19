// Must stay the first import: it sets POSTGRES_DB before `@lib/config` reads it.
import './env';
import 'reflect-metadata';
import { connect } from 'net';
import { Client } from 'pg';
import { environmentVariables as env } from '@lib/config';
import { AppDataSource } from '@lib/database/data-source';
import { E2E_DATABASE } from './env';

/**
 * Prepares the e2e database: creates it if missing, applies the migrations
 * and empties every table, so each run starts from a known state. Also
 * checks the four backing services are reachable first, because otherwise
 * the failure is a confusing timeout deep inside app start-up.
 * Run by jest's `globalSetup`, or by hand with `npm run test:e2e:db`.
 */

function assertReachable(name: string, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, timeout: 2000 });
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    const fail = () => {
      socket.destroy();
      reject(new Error(`${name} is not reachable at ${host}:${port}`));
    };
    socket.once('error', fail);
    socket.once('timeout', fail);
  });
}

async function main(): Promise<void> {
  const [kafkaHost, kafkaPort] = env.KAFKA_BROKERS[0].split(':');
  await assertReachable('Postgres', env.POSTGRES_HOST, env.POSTGRES_PORT);
  await assertReachable('Redis', env.REDIS_HOST, env.REDIS_PORT);
  await assertReachable('RabbitMQ', env.RABBITMQ_HOST, env.RABBITMQ_PORT);
  await assertReachable('Kafka', kafkaHost, Number(kafkaPort));

  const admin = new Client({
    host: env.POSTGRES_HOST,
    port: env.POSTGRES_PORT,
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    database: 'postgres',
  });
  await admin.connect();
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      E2E_DATABASE,
    ]);
    if (existing.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${E2E_DATABASE}"`);
      console.log(`Created database ${E2E_DATABASE}`);
    }
  } finally {
    await admin.end();
  }

  await AppDataSource.initialize();
  try {
    await AppDataSource.runMigrations();
    await AppDataSource.query(
      'TRUNCATE reservations, slots, locations, users, processed_events RESTART IDENTITY CASCADE',
    );
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((err) => {
  console.error(`\ne2e setup failed: ${err.message}`);
  console.error('Are the containers up? Try: docker compose up -d\n');
  process.exit(1);
});
