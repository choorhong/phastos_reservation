import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ReservationAudit } from '@lib/database';
import { bearer, createApp, http, loginAdmin, registerUser, TestUser } from './support';

/**
 * `GET /audit` reads `reservation_audit`, which event-consumer fills from
 * Kafka. The e2e suite doesn't run event-consumer, so these rows are
 * inserted directly: this covers the endpoint (access, filters, order,
 * paging). The consumer's writing side has its own unit tests.
 */
describe('audit log (e2e)', () => {
  let app: INestApplication;
  let db: DataSource;
  let admin: TestUser;
  let alice: TestUser;

  const slotId = randomUUID();
  const locationId = randomUUID();
  const reservationA = randomUUID();
  const reservationB = randomUUID();
  const userId = randomUUID();
  const seeded: string[] = [];

  /** Inserts one audit row; `minute` sets occurredAt to 2026-10-01T10:<minute>Z. */
  async function seed(
    eventType: ReservationAudit['eventType'],
    minute: number,
    reservationId: string | null,
    user: string | null = userId,
  ): Promise<string> {
    const eventId = randomUUID();
    await db.getRepository(ReservationAudit).insert({
      eventId,
      eventType,
      occurredAt: new Date(`2026-10-01T10:${String(minute).padStart(2, '0')}:00Z`),
      slotId,
      locationId,
      reservationId,
      userId: user,
      correlationId: 'corr-e2e',
      payload: { note: `${eventType} at ${minute}` },
    });
    seeded.push(eventId);
    return eventId;
  }

  const audit = (user: TestUser | null, query: Record<string, string | number>) => {
    const req = http(app).get('/audit').query(query);
    return user ? req.set('Authorization', bearer(user.token)) : req;
  };

  beforeAll(async () => {
    app = await createApp();
    db = app.get(DataSource);
    admin = await loginAdmin(app);
    alice = await registerUser(app, 'alice');

    // Inserted out of order on purpose: the endpoint must sort by occurredAt.
    await seed('ReservationConfirmed', 2, reservationA);
    await seed('ReservationRequested', 1, reservationA);
    await seed('ReservationCancelled', 5, reservationA);
    await seed('SlotReleased', 5, null, null);
    await seed('ReservationRequested', 3, reservationB);
  });

  afterAll(async () => {
    if (seeded.length > 0) {
      await db.getRepository(ReservationAudit).delete(seeded);
    }
    await app.close();
  });

  it('is admin only', async () => {
    await audit(null, { reservationId: reservationA }).expect(401);
    await audit(alice, { reservationId: reservationA }).expect(403);
  });

  it('needs at least one of reservationId, userId or slotId', async () => {
    const res = await audit(admin, {}).expect(400);
    expect(res.body.message).toMatch(/reservationId, userId or slotId/);
  });

  it('rejects malformed filters', async () => {
    await audit(admin, { reservationId: 'not-a-uuid' }).expect(400);
    await audit(admin, { slotId, limit: 501 }).expect(400);
    await audit(admin, { slotId, from: 'yesterday' }).expect(400);
  });

  it("returns one reservation's history, oldest first", async () => {
    const res = await audit(admin, { reservationId: reservationA }).expect(200);

    expect(res.body.map((e: ReservationAudit) => e.eventType)).toEqual([
      'ReservationRequested',
      'ReservationConfirmed',
      'ReservationCancelled',
    ]);
    expect(res.body[0]).toMatchObject({
      reservationId: reservationA,
      userId,
      slotId,
      locationId,
      correlationId: 'corr-e2e',
      payload: { note: 'ReservationRequested at 1' },
    });
  });

  it('filters by slot, including SlotReleased, which has no reservation', async () => {
    const res = await audit(admin, { slotId }).expect(200);

    expect(res.body).toHaveLength(5);
    const released = res.body.find((e: ReservationAudit) => e.eventType === 'SlotReleased');
    expect(released).toMatchObject({ reservationId: null, userId: null });
  });

  it('combines filters (an entry must match all of them)', async () => {
    const res = await audit(admin, { userId, reservationId: reservationB }).expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].reservationId).toBe(reservationB);
  });

  it('pages with limit and from/to', async () => {
    const firstTwo = await audit(admin, { userId, limit: 2 }).expect(200);
    expect(firstTwo.body.map((e: ReservationAudit) => e.eventType)).toEqual([
      'ReservationRequested',
      'ReservationConfirmed',
    ]);

    const window = await audit(admin, {
      slotId,
      from: '2026-10-01T10:02:00Z',
      to: '2026-10-01T10:05:00Z',
    }).expect(200);
    // from is inclusive, to is exclusive: minutes 2 and 3, not 1 or 5.
    expect(window.body.map((e: ReservationAudit) => e.occurredAt)).toEqual([
      '2026-10-01T10:02:00.000Z',
      '2026-10-01T10:03:00.000Z',
    ]);
  });
});
