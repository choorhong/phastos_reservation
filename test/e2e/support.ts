import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { ACTIVE_SLOTS_KEY, slotKeys } from '@lib/redis-scripts';
import { AppModule } from '@app/api/app.module';
import { configureApp } from '@app/api/app.setup';
import { REDIS_CLIENT } from '@app/api/modules/redis/redis-client.provider';
import { E2E_ADMIN } from './env';

export interface TestUser {
  email: string;
  token: string;
  userId: string;
}

export interface LocationJson {
  id: string;
  name: string;
  address: string;
  timezone: string;
}

export interface SlotJson {
  id: string;
  locationId: string;
  startTime: string;
  endTime: string;
  capacity: number;
  available: number;
  timezone: string;
  localDate: string;
  localStartTime: string;
  localEndTime: string;
}

export interface ReservationJson {
  id: string;
  status: 'held' | 'confirmed' | 'cancelled' | 'expired';
  userId: string;
  slotId: string;
  confirmedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  slot: Pick<
    SlotJson,
    'id' | 'startTime' | 'endTime' | 'timezone' | 'localDate' | 'localStartTime' | 'localEndTime'
  >;
  location: { id: string; name: string; address: string };
}

/** Boots the real `AppModule` with the same request handling as `main.ts`. */
export async function createApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  // Listen once on a free port: without it supertest opens a new port per
  // request, which breaks down under many simultaneous requests.
  await app.listen(0);
  return app;
}

export const http = (app: INestApplication) => request(app.getHttpServer());

export const bearer = (token: string) => `Bearer ${token}`;

/** A name that can't collide with anything from another run or another test. */
export const unique = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

export function decodeJwt(token: string): { sub: string; role: string } {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
}

export async function registerUser(app: INestApplication, label = 'user'): Promise<TestUser> {
  const email = `${unique(label)}@test.local`;
  const res = await http(app)
    .post('/auth/register')
    .send({ email, password: 'password123' })
    .expect(201);
  return { email, token: res.body.accessToken, userId: decodeJwt(res.body.accessToken).sub };
}

/** The admin is bootstrapped from ADMIN_EMAIL/ADMIN_PASSWORD when the app starts. */
export async function loginAdmin(app: INestApplication): Promise<TestUser> {
  const res = await http(app).post('/auth/login').send(E2E_ADMIN).expect(200);
  return {
    email: E2E_ADMIN.email,
    token: res.body.accessToken,
    userId: decodeJwt(res.body.accessToken).sub,
  };
}

export async function createLocation(
  app: INestApplication,
  admin: TestUser,
  overrides: Partial<Omit<LocationJson, 'id'>> = {},
): Promise<LocationJson> {
  const res = await http(app)
    .post('/locations')
    .set('Authorization', bearer(admin.token))
    .send({
      name: unique('Store'),
      address: '1 Test Street',
      timezone: 'Asia/Singapore',
      ...overrides,
    })
    .expect(201);
  return res.body;
}

export async function listSlots(
  app: INestApplication,
  user: TestUser,
  query: Record<string, string>,
): Promise<SlotJson[]> {
  const res = await http(app)
    .get('/slots')
    .query(query)
    .set('Authorization', bearer(user.token))
    .expect(200);
  return res.body;
}

export function setCapacity(
  app: INestApplication,
  admin: TestUser,
  slotId: string,
  capacity: number,
) {
  return http(app)
    .patch(`/slots/${slotId}`)
    .set('Authorization', bearer(admin.token))
    .send({ capacity });
}

export const hold = (app: INestApplication, user: TestUser, slotId: string) =>
  http(app).post('/reservations').set('Authorization', bearer(user.token)).send({ slotId });

export const confirm = (app: INestApplication, user: TestUser, reservationId: string) =>
  http(app).post(`/reservations/${reservationId}/confirm`).set('Authorization', bearer(user.token));

export const cancel = (
  app: INestApplication,
  user: TestUser,
  reservationId: string,
  body: object = {},
) =>
  http(app)
    .post(`/reservations/${reservationId}/cancel`)
    .set('Authorization', bearer(user.token))
    .send(body);

export const getReservation = (app: INestApplication, user: TestUser, reservationId: string) =>
  http(app).get(`/reservations/${reservationId}`).set('Authorization', bearer(user.token));

/** Polls until `check` stops throwing, for things that happen asynchronously (hold expiry). */
export async function eventually<T>(
  check: () => Promise<T> | T,
  { timeoutMs = 10000, intervalMs = 100 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await check();
    } catch (err) {
      if (Date.now() >= deadline) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

/** Removes the Redis keys a test's slots left behind (their counters, holds, pending sets). */
export async function cleanUpRedis(app: INestApplication, slotIds: Iterable<string>) {
  const redis = app.get<Redis>(REDIS_CLIENT);
  for (const id of slotIds) {
    const holdKeys = await redis.keys(`hold:{${id}}:*`);
    await redis.del(slotKeys(id).available, slotKeys(id).pending, ...holdKeys);
    await redis.srem(ACTIVE_SLOTS_KEY, id);
  }
}
