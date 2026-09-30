import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { slotKeys } from '@lib/redis-scripts';
import { EventsPublisherService } from '@app/api/modules/events/events-publisher.service';
import { NotificationsPublisherService } from '@app/api/modules/notifications/notifications-publisher.service';
import { REDIS_CLIENT } from '@app/api/modules/redis/redis-client.provider';
import { HOLD_TTL_MS } from './env';
import {
  bearer,
  cancel,
  cleanUpRedis,
  confirm,
  createApp,
  createLocation,
  eventually,
  getReservation,
  hold,
  http,
  listSlots,
  loginAdmin,
  LocationJson,
  registerUser,
  ReservationJson,
  setCapacity,
  SlotJson,
  TestUser,
} from './support';

describe('reservations (e2e)', () => {
  let app: INestApplication;
  let redis: Redis;
  let db: DataSource;
  let events: EventsPublisherService;
  let notifications: NotificationsPublisherService;
  let admin: TestUser;
  let location: LocationJson;
  let slots: SlotJson[];
  let cursor = 0;
  const touchedSlots = new Set<string>();
  let eventSpies: Record<string, jest.SpyInstance>;

  /** Every test takes its own slot(s), so tests can't interfere with each other. */
  const nextSlot = (): SlotJson => {
    const slot = slots[cursor++];
    touchedSlots.add(slot.id);
    return slot;
  };

  /** A slot with exactly `capacity` spots. */
  const slotWithCapacity = async (capacity: number): Promise<SlotJson> => {
    const slot = nextSlot();
    if (capacity !== slot.capacity) {
      await setCapacity(app, admin, slot.id, capacity).expect(200);
    }
    return slot;
  };

  const availableInPostgres = async (slot: SlotJson): Promise<number> => {
    const [row] = await listSlots(app, admin, {
      locationId: location.id,
      date: slot.localDate,
    }).then((day) => day.filter((s) => s.id === slot.id));
    return row.available;
  };

  const redisAvailable = async (slot: SlotJson): Promise<number | null> => {
    const value = await redis.get(slotKeys(slot.id).available);
    return value === null ? null : Number(value);
  };

  const countRows = async (slotId: string, status?: string): Promise<number> => {
    const rows = await db.query(
      `SELECT count(*)::int AS n FROM reservations WHERE slot_id = $1 ${status ? 'AND status = $2' : ''}`,
      status ? [slotId, status] : [slotId],
    );
    return rows[0].n;
  };

  /** Asserts every publish the spy saw actually succeeded (the service only logs failures). */
  const expectPublished = async (spy: jest.SpyInstance, times: number) => {
    expect(spy).toHaveBeenCalledTimes(times);
    await Promise.all(spy.mock.results.map((r) => expect(r.value).resolves.toBeUndefined()));
  };

  beforeAll(async () => {
    app = await createApp();
    redis = app.get<Redis>(REDIS_CLIENT);
    db = app.get(DataSource);
    events = app.get(EventsPublisherService);
    notifications = app.get(NotificationsPublisherService);
    admin = await loginAdmin(app);
    location = await createLocation(app, admin, { timezone: 'Asia/Singapore' });
    slots = await listSlots(app, admin, { locationId: location.id });

    // Pass-through spies: the real brokers still receive everything.
    eventSpies = {
      requested: jest.spyOn(events, 'publishReservationRequested'),
      confirmed: jest.spyOn(events, 'publishReservationConfirmed'),
      cancelled: jest.spyOn(events, 'publishReservationCancelled'),
      released: jest.spyOn(events, 'publishSlotReleased'),
      confirmationEmail: jest.spyOn(notifications, 'publishConfirmationEmail'),
      receipt: jest.spyOn(notifications, 'publishReceipt'),
    };
  });

  beforeEach(() => jest.clearAllMocks());

  afterAll(async () => {
    await cleanUpRedis(app, touchedSlots);
    await app.close();
  });

  describe('booking lifecycle', () => {
    it('holds, confirms and cancels, returning the slot at each step', async () => {
      const alice = await registerUser(app, 'alice');
      const slot = nextSlot();

      const held = await hold(app, alice, slot.id).expect(201);
      expect(held.body).toMatchObject({
        status: 'held',
        userId: alice.userId,
        slotId: slot.id,
        confirmedAt: null,
        cancelledAt: null,
        location: { id: location.id, name: location.name },
        slot: {
          id: slot.id,
          timezone: 'Asia/Singapore',
          localDate: slot.localDate,
          localStartTime: slot.localStartTime,
          localEndTime: slot.localEndTime,
        },
      });
      expect(held.body).not.toHaveProperty('holdId');
      expect(await availableInPostgres(slot)).toBe(2);
      expect(await redisAvailable(slot)).toBe(2);

      const confirmed = await confirm(app, alice, held.body.id).expect(200);
      expect(confirmed.body.status).toBe('confirmed');
      expect(confirmed.body.confirmedAt).not.toBeNull();
      expect(await availableInPostgres(slot)).toBe(2);

      const cancelled = await cancel(app, alice, held.body.id).expect(200);
      expect(cancelled.body).toMatchObject({ status: 'cancelled', cancelReason: 'user_cancelled' });
      expect(cancelled.body.cancelledAt).not.toBeNull();
      expect(await availableInPostgres(slot)).toBe(3);
      expect(await redisAvailable(slot)).toBe(3);
    });

    it('publishes the lifecycle events and notifications, and the brokers accept them', async () => {
      const alice = await registerUser(app, 'alice');
      const slot = nextSlot();

      const held = await hold(app, alice, slot.id).expect(201);
      await expectPublished(eventSpies.requested, 1);
      expect(eventSpies.requested).toHaveBeenCalledWith(
        expect.objectContaining({ slotId: slot.id, locationId: location.id }),
        expect.objectContaining({ reservationId: held.body.id, userId: alice.userId }),
      );

      await confirm(app, alice, held.body.id).expect(200);
      await expectPublished(eventSpies.confirmed, 1);
      expect(eventSpies.confirmed).toHaveBeenCalledWith(
        expect.objectContaining({ slotId: slot.id }),
        expect.objectContaining({
          reservationId: held.body.id,
          slotStartTime: slot.startTime,
          slotEndTime: slot.endTime,
        }),
      );
      await expectPublished(eventSpies.confirmationEmail, 1);
      expect(eventSpies.confirmationEmail).toHaveBeenCalledWith(
        expect.objectContaining({ reservationId: held.body.id, locationName: location.name }),
        expect.any(String),
      );
      await expectPublished(eventSpies.receipt, 1);

      await cancel(app, alice, held.body.id).expect(200);
      await expectPublished(eventSpies.cancelled, 1);
      await expectPublished(eventSpies.released, 1);
      expect(eventSpies.released).toHaveBeenCalledWith(
        expect.objectContaining({ slotId: slot.id }),
        expect.objectContaining({ releasedCapacity: 1, reason: 'cancellation' }),
      );
    });

    it('can cancel a hold that was never confirmed', async () => {
      const alice = await registerUser(app, 'alice');
      const slot = nextSlot();
      const held = await hold(app, alice, slot.id).expect(201);

      await cancel(app, alice, held.body.id).expect(200);

      expect(await availableInPostgres(slot)).toBe(3);
      expect(await redisAvailable(slot)).toBe(3);
    });

    it('confirm is idempotent and does not publish twice', async () => {
      const alice = await registerUser(app, 'alice');
      const held = await hold(app, alice, nextSlot().id).expect(201);

      await confirm(app, alice, held.body.id).expect(200);
      const again = await confirm(app, alice, held.body.id).expect(200);

      expect(again.body.status).toBe('confirmed');
      expect(eventSpies.confirmed).toHaveBeenCalledTimes(1);
      expect(eventSpies.confirmationEmail).toHaveBeenCalledTimes(1);
    });

    it('cancel is idempotent and returns capacity only once', async () => {
      const alice = await registerUser(app, 'alice');
      const slot = nextSlot();
      const held = await hold(app, alice, slot.id).expect(201);
      await confirm(app, alice, held.body.id).expect(200);

      await cancel(app, alice, held.body.id).expect(200);
      await cancel(app, alice, held.body.id).expect(200);

      expect(eventSpies.released).toHaveBeenCalledTimes(1);
      expect(await redisAvailable(slot)).toBe(3);
    });

    it('will not confirm a cancelled reservation', async () => {
      const alice = await registerUser(app, 'alice');
      const held = await hold(app, alice, nextSlot().id).expect(201);
      await cancel(app, alice, held.body.id).expect(200);

      await confirm(app, alice, held.body.id).expect(409);
    });

    it('rejects bad input: unknown or malformed slot and reservation ids', async () => {
      const alice = await registerUser(app, 'alice');
      await hold(app, alice, randomUUID()).expect(404);
      await hold(app, alice, 'not-a-uuid').expect(400);
      await confirm(app, alice, randomUUID()).expect(404);
      await cancel(app, alice, randomUUID()).expect(404);
      await confirm(app, alice, 'not-a-uuid').expect(400);
      await getReservation(app, alice, randomUUID()).expect(404);
    });

    it('does not let a client set a system-only cancel reason', async () => {
      const alice = await registerUser(app, 'alice');
      const held = await hold(app, alice, nextSlot().id).expect(201);
      await cancel(app, alice, held.body.id, { reason: 'hold_expired' }).expect(400);
    });
  });

  describe('viewing reservations', () => {
    it("lists only the caller's own, soonest slot first, and filters by status", async () => {
      const alice = await registerUser(app, 'alice');
      const bob = await registerUser(app, 'bob');
      const [first, second, third] = [nextSlot(), nextSlot(), nextSlot()];

      // Booked out of order on purpose.
      const r3 = await hold(app, alice, third.id).expect(201);
      const r1 = await hold(app, alice, first.id).expect(201);
      const r2 = await hold(app, alice, second.id).expect(201);
      await hold(app, bob, nextSlot().id).expect(201);
      await confirm(app, alice, r1.body.id).expect(200);

      const all = await http(app)
        .get('/reservations')
        .set('Authorization', bearer(alice.token))
        .expect(200);
      expect(all.body.map((r: ReservationJson) => r.id)).toEqual([
        r1.body.id,
        r2.body.id,
        r3.body.id,
      ]);
      expect(all.body.every((r: ReservationJson) => r.userId === alice.userId)).toBe(true);

      const confirmedOnly = await http(app)
        .get('/reservations')
        .query({ status: 'confirmed' })
        .set('Authorization', bearer(alice.token))
        .expect(200);
      expect(confirmedOnly.body.map((r: ReservationJson) => r.id)).toEqual([r1.body.id]);

      await http(app)
        .get('/reservations')
        .query({ status: 'bogus' })
        .set('Authorization', bearer(alice.token))
        .expect(400);
    });

    it('starts empty for a new user', async () => {
      const carol = await registerUser(app, 'carol');
      const res = await http(app)
        .get('/reservations')
        .set('Authorization', bearer(carol.token))
        .expect(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('ownership', () => {
    it("keeps users out of each other's reservations but lets an admin in", async () => {
      const alice = await registerUser(app, 'alice');
      const bob = await registerUser(app, 'bob');
      const held = await hold(app, alice, nextSlot().id).expect(201);
      const id = held.body.id;

      await getReservation(app, bob, id).expect(403);
      await confirm(app, bob, id).expect(403);
      await cancel(app, bob, id).expect(403);

      await getReservation(app, admin, id).expect(200);
      await confirm(app, admin, id).expect(200);
      const cancelled = await cancel(app, admin, id, { reason: 'admin_cancelled' }).expect(200);
      expect(cancelled.body.cancelReason).toBe('admin_cancelled');
    });

    it('is unaffected by anything in the request body claiming another user', async () => {
      const alice = await registerUser(app, 'alice');
      const bob = await registerUser(app, 'bob');
      const res = await http(app)
        .post('/reservations')
        .set('Authorization', bearer(alice.token))
        .send({ slotId: nextSlot().id, userId: bob.userId })
        .expect(201);
      expect(res.body.userId).toBe(alice.userId);
    });
  });

  describe('a full slot', () => {
    it('turns away the fourth person and admits them once a spot frees up', async () => {
      const slot = nextSlot();
      const [u1, u2, u3, u4] = await Promise.all(
        [1, 2, 3, 4].map((n) => registerUser(app, `full${n}`)),
      );

      const r1 = await hold(app, u1, slot.id).expect(201);
      await hold(app, u2, slot.id).expect(201);
      await hold(app, u3, slot.id).expect(201);
      expect(await availableInPostgres(slot)).toBe(0);

      await hold(app, u4, slot.id).expect(409);
      expect(await countRows(slot.id)).toBe(3);

      await cancel(app, u1, r1.body.id).expect(200);
      await hold(app, u4, slot.id).expect(201);
      expect(await availableInPostgres(slot)).toBe(0);
    });

    it('refuses holds on a slot an admin has closed', async () => {
      const slot = await slotWithCapacity(0);
      const alice = await registerUser(app, 'alice');
      await hold(app, alice, slot.id).expect(409);
    });

    it('will not let an admin shrink a slot below its active reservations', async () => {
      const slot = nextSlot();
      const [u1, u2] = await Promise.all([registerUser(app, 'a'), registerUser(app, 'b')]);
      await hold(app, u1, slot.id).expect(201);
      await hold(app, u2, slot.id).expect(201);

      await setCapacity(app, admin, slot.id, 1).expect(409);
      await setCapacity(app, admin, slot.id, 2).expect(200);
      // The Redis counter followed the change: nothing left to claim.
      expect(await redisAvailable(slot)).toBe(0);
    });

    it('applies a capacity increase to the live counter', async () => {
      const slot = await slotWithCapacity(1);
      const [u1, u2] = await Promise.all([registerUser(app, 'a'), registerUser(app, 'b')]);
      await hold(app, u1, slot.id).expect(201);
      await hold(app, u2, slot.id).expect(409);

      await setCapacity(app, admin, slot.id, 2).expect(200);

      await hold(app, u2, slot.id).expect(201);
    });
  });

  describe('one spot per person per slot', () => {
    it('turns away a second hold, before and after confirming, and leaves the count alone', async () => {
      const slot = nextSlot(); // 3 spots
      const alice = await registerUser(app, 'alice');
      const bob = await registerUser(app, 'bob');

      const first = await hold(app, alice, slot.id).expect(201);
      await hold(app, alice, slot.id).expect(409);
      expect(await countRows(slot.id)).toBe(1);
      expect(await redisAvailable(slot)).toBe(2);

      await confirm(app, alice, first.body.id).expect(200);
      await hold(app, alice, slot.id).expect(409);
      expect(await countRows(slot.id)).toBe(1);
      expect(await redisAvailable(slot)).toBe(2);

      // Someone else is unaffected.
      await hold(app, bob, slot.id).expect(201);
    });

    it('lets a user book the slot again once they have cancelled', async () => {
      const slot = nextSlot();
      const alice = await registerUser(app, 'alice');

      const first = await hold(app, alice, slot.id).expect(201);
      await cancel(app, alice, first.body.id).expect(200);

      await hold(app, alice, slot.id).expect(201);
      expect(await countRows(slot.id, 'held')).toBe(1);
      expect(await countRows(slot.id, 'cancelled')).toBe(1);
    });

    it('lets only one of a user’s simultaneous requests through and returns the other spots', async () => {
      const slot = nextSlot(); // 3 spots
      const alice = await registerUser(app, 'alice');

      const results = await Promise.all(Array.from({ length: 6 }, () => hold(app, alice, slot.id)));

      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(5);
      expect(await countRows(slot.id)).toBe(1);
      // Every request that lost the race must have handed its Redis spot back.
      expect(await redisAvailable(slot)).toBe(2);
      expect(await availableInPostgres(slot)).toBe(2);
    });
  });

  describe('many people booking the same slot at once', () => {
    it('admits exactly as many as there are spots and never double-books', async () => {
      const slot = nextSlot(); // 3 spots
      const users = await Promise.all(
        Array.from({ length: 12 }, (_, i) => registerUser(app, `herd${i}`)),
      );

      const results = await Promise.all(users.map((u) => hold(app, u, slot.id)));

      const winners = results.filter((r) => r.status === 201);
      const losers = results.filter((r) => r.status === 409);
      expect(winners).toHaveLength(3);
      expect(losers).toHaveLength(9);
      expect(await countRows(slot.id)).toBe(3);
      expect(await redisAvailable(slot)).toBe(0);
      expect(await availableInPostgres(slot)).toBe(0);

      // The winners all confirm at the same moment: still exactly three seats.
      const confirms = await Promise.all(
        winners.map((w, i) => confirm(app, users[results.indexOf(w)], w.body.id)),
      );
      expect(confirms.map((c) => c.status)).toEqual([200, 200, 200]);
      expect(await countRows(slot.id, 'confirmed')).toBe(3);

      // Losers stay out until someone lets go.
      const loser = users[results.indexOf(losers[0])];
      await hold(app, loser, slot.id).expect(409);
      const first = winners[0];
      await cancel(app, users[results.indexOf(first)], first.body.id).expect(200);
      await hold(app, loser, slot.id).expect(201);
    });

    it('lets exactly one of many people have the last spot', async () => {
      const slot = await slotWithCapacity(1);
      const users = await Promise.all(
        Array.from({ length: 10 }, (_, i) => registerUser(app, `last${i}`)),
      );

      const results = await Promise.all(users.map((u) => hold(app, u, slot.id)));

      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(9);
      expect(await countRows(slot.id)).toBe(1);
    });
  });

  describe('a hold that runs out', () => {
    /** Waits for the hold reaper to hand the spot back in Redis. */
    const waitForReaper = (slot: SlotJson, expected: number) =>
      eventually(async () => expect(await redisAvailable(slot)).toBe(expected), {
        timeoutMs: HOLD_TTL_MS + 8000,
      });

    it('returns the spot to the next person, and refuses the late confirm', async () => {
      const slot = await slotWithCapacity(1);
      const alice = await registerUser(app, 'alice');
      const bob = await registerUser(app, 'bob');

      const aliceHold = await hold(app, alice, slot.id).expect(201);
      await hold(app, bob, slot.id).expect(409);

      await waitForReaper(slot, 1);
      const bobHold = await hold(app, bob, slot.id).expect(201);

      // Alice comes back too late: 410 Gone, and her reservation is marked expired.
      await confirm(app, alice, aliceHold.body.id).expect(410);
      const late = await getReservation(app, alice, aliceHold.body.id).expect(200);
      expect(late.body.status).toBe('expired');
      await cancel(app, alice, aliceHold.body.id).expect(409);

      // Bob is unaffected and can still complete his booking.
      await confirm(app, bob, bobHold.body.id).expect(200);
      expect(await countRows(slot.id, 'confirmed')).toBe(1);
    });

    it('marks an abandoned hold as expired in Postgres and tells downstream', async () => {
      const slot = await slotWithCapacity(1);
      const alice = await registerUser(app, 'alice');
      const aliceHold = await hold(app, alice, slot.id).expect(201);

      await waitForReaper(slot, 1);

      // The Postgres side follows the Redis release a moment later.
      await eventually(async () => {
        const reservation = await getReservation(app, alice, aliceHold.body.id).expect(200);
        expect(reservation.body).toMatchObject({ status: 'expired', cancelReason: 'hold_expired' });
      });
      expect(await availableInPostgres(slot)).toBe(1);
      expect(await countRows(slot.id, 'held')).toBe(0);

      await eventually(() => {
        expect(eventSpies.cancelled).toHaveBeenCalledWith(
          expect.objectContaining({ slotId: slot.id }),
          expect.objectContaining({ reservationId: aliceHold.body.id, reason: 'hold_expired' }),
        );
        expect(eventSpies.released).toHaveBeenCalledWith(
          expect.objectContaining({ slotId: slot.id }),
          expect.objectContaining({ releasedCapacity: 1, reason: 'hold_expired' }),
        );
      });

      // ...and an admin is no longer blocked by a phantom reservation.
      await setCapacity(app, admin, slot.id, 0).expect(200);
    });

    it('leaves a reservation alone when it was confirmed before the hold ran out', async () => {
      const slot = await slotWithCapacity(1);
      const alice = await registerUser(app, 'alice');
      const aliceHold = await hold(app, alice, slot.id).expect(201);
      await confirm(app, alice, aliceHold.body.id).expect(200);

      await new Promise((resolve) => setTimeout(resolve, HOLD_TTL_MS + 1500));

      const reservation = await getReservation(app, alice, aliceHold.body.id).expect(200);
      expect(reservation.body.status).toBe('confirmed');
      expect(await redisAvailable(slot)).toBe(0);
      expect(eventSpies.cancelled).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ reservationId: aliceHold.body.id }),
      );
    });
  });

  describe('Postgres as the backstop when Redis is wrong', () => {
    const insertConfirmed = (slotId: string, tag: string) =>
      db.query(
        `INSERT INTO reservations (slot_id, user_id, hold_id, status) VALUES ($1, $2, $3, 'confirmed')`,
        [slotId, `direct-${tag}`, randomUUID()],
      );

    it('refuses to over-fill a slot even with Redis bypassed entirely', async () => {
      const slot = await slotWithCapacity(1);

      await insertConfirmed(slot.id, 'a');
      await expect(insertConfirmed(slot.id, 'b')).rejects.toThrow(/SLOT_CAPACITY_EXCEEDED/);

      expect(await countRows(slot.id, 'confirmed')).toBe(1);
    });

    it('refuses a second active reservation for the same user and slot even with the API bypassed', async () => {
      const slot = nextSlot();
      const insert = (status: string) =>
        db.query(
          `INSERT INTO reservations (slot_id, user_id, hold_id, status) VALUES ($1, 'direct-user', $2, $3)`,
          [slot.id, randomUUID(), status],
        );

      await insert('held');
      await expect(insert('confirmed')).rejects.toThrow(/uq_reservations_active_user_slot/);
      // Closed-off rows don't count against the rule.
      await insert('cancelled');
      await insert('expired');

      expect(await countRows(slot.id)).toBe(3);
    });

    it('never confirms more than the capacity when the Redis counter is stale, and says 409', async () => {
      const slot = await slotWithCapacity(1);
      const alice = await registerUser(app, 'alice');
      const bob = await registerUser(app, 'bob');
      const aliceHold = await hold(app, alice, slot.id).expect(201);
      await confirm(app, alice, aliceHold.body.id).expect(200);

      // Simulate a lost or stale cache: Redis now claims plenty of room.
      await redis.set(slotKeys(slot.id).available, '5');
      const bobHold = await hold(app, bob, slot.id).expect(201);
      const bobConfirm = await confirm(app, bob, bobHold.body.id);

      // Postgres refuses the second confirmation and the API says so plainly.
      expect(bobConfirm.status).toBe(409);
      expect(bobConfirm.body.message).toMatch(/already full/);
      expect(await countRows(slot.id, 'confirmed')).toBe(1);

      // Bob's reservation is closed off, not left dangling as `held`.
      const bobReservation = await getReservation(app, bob, bobHold.body.id).expect(200);
      expect(bobReservation.body).toMatchObject({
        status: 'cancelled',
        cancelReason: 'slot_full',
        confirmedAt: null,
      });
      expect(await countRows(slot.id, 'held')).toBe(0);

      // Consumers see Bob's lifecycle end, but no capacity is released.
      expect(eventSpies.cancelled).toHaveBeenCalledTimes(1);
      expect(eventSpies.cancelled).toHaveBeenCalledWith(
        expect.objectContaining({ slotId: slot.id }),
        expect.objectContaining({ reservationId: bobHold.body.id, reason: 'slot_full' }),
      );
      expect(eventSpies.released).not.toHaveBeenCalled();
    });
  });
});
