import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import {
  bearer,
  createApp,
  createLocation,
  http,
  listSlots,
  loginAdmin,
  LocationJson,
  registerUser,
  setCapacity,
  SlotJson,
  TestUser,
} from './support';

const SLOT_STARTS = ['10:00', '12:00', '14:00', '16:00'];
const SLOT_ENDS = ['12:00', '14:00', '16:00', '18:00'];

/** ISO weekday (Mon=1..Sun=7) of a `YYYY-MM-DD` calendar date. */
function isoWeekday(localDate: string): number {
  return new Date(`${localDate}T00:00:00Z`).getUTCDay() || 7;
}

describe('locations and generated slots (e2e)', () => {
  let app: INestApplication;
  let admin: TestUser;
  let user: TestUser;
  let singapore: LocationJson;
  let losAngeles: LocationJson;
  let sgSlots: SlotJson[];
  let laSlots: SlotJson[];

  beforeAll(async () => {
    app = await createApp();
    admin = await loginAdmin(app);
    user = await registerUser(app);
    singapore = await createLocation(app, admin, { timezone: 'Asia/Singapore' });
    losAngeles = await createLocation(app, admin, { timezone: 'America/Los_Angeles' });
    sgSlots = await listSlots(app, user, { locationId: singapore.id });
    laSlots = await listSlots(app, user, { locationId: losAngeles.id });
  });

  afterAll(() => app.close());

  describe('locations', () => {
    it('are listed for any signed-in user', async () => {
      const res = await http(app)
        .get('/locations')
        .set('Authorization', bearer(user.token))
        .expect(200);
      const ids = res.body.map((l: LocationJson) => l.id);
      expect(ids).toEqual(expect.arrayContaining([singapore.id, losAngeles.id]));
    });

    it.each([
      ['an invalid timezone', { name: 'X', address: 'Y', timezone: 'Mars/Olympus' }],
      ['a missing name', { address: 'Y', timezone: 'Asia/Singapore' }],
      ['an empty address', { name: 'X', address: '', timezone: 'Asia/Singapore' }],
    ])('cannot be created with %s', async (_label, body) => {
      await http(app)
        .post('/locations')
        .set('Authorization', bearer(admin.token))
        .send(body)
        .expect(400);
    });

    describe('editing (PATCH)', () => {
      const patch = (token: string, id: string, body: object) =>
        http(app).patch(`/locations/${id}`).set('Authorization', bearer(token)).send(body);

      it('changes the name and address, and shows up in the list', async () => {
        const location = await createLocation(app, admin);

        const res = await patch(admin.token, location.id, {
          name: 'Renamed Store',
          address: '9 New Road',
        }).expect(200);

        expect(res.body).toMatchObject({
          id: location.id,
          name: 'Renamed Store',
          address: '9 New Road',
          timezone: location.timezone,
        });
        const list = await http(app)
          .get('/locations')
          .set('Authorization', bearer(user.token))
          .expect(200);
        expect(list.body.find((l: LocationJson) => l.id === location.id)).toMatchObject({
          name: 'Renamed Store',
          address: '9 New Road',
        });
      });

      it('changes one field and leaves the other alone', async () => {
        const location = await createLocation(app, admin);

        const res = await patch(admin.token, location.id, { address: '2 Other Street' }).expect(
          200,
        );

        expect(res.body).toMatchObject({ name: location.name, address: '2 Other Street' });
      });

      it('ignores the timezone and any other field, and leaves the slots alone', async () => {
        const location = await createLocation(app, admin, { timezone: 'Asia/Singapore' });
        const before = await listSlots(app, admin, { locationId: location.id });

        const res = await patch(admin.token, location.id, {
          name: 'Still Singapore',
          timezone: 'America/New_York',
          id: randomUUID(),
          slots: [],
          isAdmin: true,
        }).expect(200);

        expect(res.body).toMatchObject({
          id: location.id,
          name: 'Still Singapore',
          timezone: 'Asia/Singapore',
        });
        const after = await listSlots(app, admin, { locationId: location.id });
        expect(after.map((s) => [s.id, s.startTime, s.localStartTime])).toEqual(
          before.map((s) => [s.id, s.startTime, s.localStartTime]),
        );
      });

      it('changes nothing when the body has no editable field', async () => {
        const location = await createLocation(app, admin);

        const res = await patch(admin.token, location.id, { timezone: 'America/New_York' }).expect(
          200,
        );

        expect(res.body).toMatchObject({
          name: location.name,
          address: location.address,
          timezone: location.timezone,
        });
      });

      it.each([
        ['an empty name', { name: '' }],
        ['an empty address', { address: '' }],
        ['a name that is not a string', { name: 42 }],
      ])('rejects %s', async (_label, body) => {
        const location = await createLocation(app, admin);
        await patch(admin.token, location.id, body).expect(400);
      });

      it('is for admins only', async () => {
        const location = await createLocation(app, admin);
        await patch(user.token, location.id, { name: 'Hijacked' }).expect(403);
        await http(app).patch(`/locations/${location.id}`).send({ name: 'x' }).expect(401);
      });

      it('404s an unknown location and 400s a malformed id', async () => {
        await patch(admin.token, randomUUID(), { name: 'x' }).expect(404);
        await patch(admin.token, 'not-a-uuid', { name: 'x' }).expect(400);
      });
    });
  });

  describe('slot generation', () => {
    it('stocks a new location with slots straight away', () => {
      expect(sgSlots.length).toBeGreaterThan(0);
      expect(laSlots.length).toBeGreaterThan(0);
    });

    it.each([
      ['Singapore', () => sgSlots],
      ['Los Angeles', () => laSlots],
    ])('follows the rule for %s: weekdays, 10-18 in 2h blocks, 3 spots', (_name, slots) => {
      for (const slot of slots()) {
        expect(slot.capacity).toBe(3);
        expect(slot.available).toBe(3);
        expect(isoWeekday(slot.localDate)).toBeLessThanOrEqual(5);
        const i = SLOT_STARTS.indexOf(slot.localStartTime);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(slot.localEndTime).toBe(SLOT_ENDS[i]);
      }
    });

    it('never offers a slot in the past or beyond the 30-day window', () => {
      const now = Date.now();
      const horizon = now + 32 * 24 * 60 * 60 * 1000;
      for (const slot of [...sgSlots, ...laSlots]) {
        expect(new Date(slot.startTime).getTime()).toBeGreaterThan(now);
        expect(new Date(slot.startTime).getTime()).toBeLessThan(horizon);
      }
    });

    it('creates four slots for every full day', () => {
      const perDay = new Map<string, number>();
      for (const slot of sgSlots) {
        perDay.set(slot.localDate, (perDay.get(slot.localDate) ?? 0) + 1);
      }
      const days = [...perDay.entries()].sort();
      // The first day can be partly over already; every later day is whole.
      expect(days.slice(1).every(([, count]) => count === 4)).toBe(true);
      expect(days.length).toBeGreaterThanOrEqual(20);
    });

    it('is idempotent: running it again creates nothing and changes nothing', async () => {
      await http(app).post('/slots/generate').set('Authorization', bearer(admin.token)).expect(201);
      const res = await http(app)
        .post('/slots/generate')
        .set('Authorization', bearer(admin.token))
        .expect(201);
      expect(res.body).toEqual({ created: 0 });
      const after = await listSlots(app, user, { locationId: singapore.id });
      expect(after.map((s) => s.id)).toEqual(sgSlots.map((s) => s.id));
    });

    it('no longer lets anyone create a single slot by hand', async () => {
      await http(app)
        .post('/slots')
        .set('Authorization', bearer(admin.token))
        .send({ locationId: singapore.id, startTime: '2030-01-01T00:00:00Z' })
        .expect(404);
    });
  });

  describe('local times', () => {
    it("shows the same local slot on each location's own clock", async () => {
      // A date well inside the window, so both locations have it.
      const date = sgSlots[sgSlots.length >> 1].localDate;
      const sg = await listSlots(app, user, { locationId: singapore.id, date });
      const la = await listSlots(app, user, { locationId: losAngeles.id, date });

      expect(sg.map((s) => s.localStartTime)).toEqual(SLOT_STARTS);
      expect(la.map((s) => s.localStartTime)).toEqual(SLOT_STARTS);
      expect(sg[0].timezone).toBe('Asia/Singapore');
      expect(la[0].timezone).toBe('America/Los_Angeles');
      // ...which are different instants: LA is 15-16h behind Singapore.
      const hoursApart =
        (new Date(la[0].startTime).getTime() - new Date(sg[0].startTime).getTime()) / 3_600_000;
      expect([15, 16]).toContain(hoursApart);
    });

    it('returns exactly one local day for ?date, in the location timezone', async () => {
      const date = sgSlots[sgSlots.length >> 1].localDate;
      const slots = await listSlots(app, user, { locationId: singapore.id, date });
      expect(slots).toHaveLength(4);
      expect(slots.every((s) => s.localDate === date)).toBe(true);
    });

    it('returns nothing for a weekend date', async () => {
      // Find the next Saturday from the slot list's own dates.
      const first = new Date(`${sgSlots[0].localDate}T00:00:00Z`);
      const daysToSaturday = (6 - first.getUTCDay() + 7) % 7 || 7;
      first.setUTCDate(first.getUTCDate() + daysToSaturday);
      const saturday = first.toISOString().slice(0, 10);
      const slots = await listSlots(app, user, { locationId: singapore.id, date: saturday });
      expect(slots).toEqual([]);
    });

    it.each([
      ['date without a locationId', () => ({ date: '2030-01-07' })],
      [
        'date combined with from',
        () => ({ locationId: singapore.id, date: '2030-01-07', from: '2030-01-07T00:00:00Z' }),
      ],
      ['an impossible date', () => ({ locationId: singapore.id, date: '2030-02-30' })],
      ['a badly formatted date', () => ({ locationId: singapore.id, date: '07-01-2030' })],
    ])('rejects %s', async (_label, query) => {
      await http(app)
        .get('/slots')
        .query(query())
        .set('Authorization', bearer(user.token))
        .expect(400);
    });

    it('404s ?date for an unknown location', async () => {
      await http(app)
        .get('/slots')
        .query({ locationId: randomUUID(), date: '2030-01-07' })
        .set('Authorization', bearer(user.token))
        .expect(404);
    });
  });

  describe('closing and reopening a slot (PATCH)', () => {
    it('closes a slot, keeps it closed across a generation run, and reopens it', async () => {
      const slot = sgSlots[10];

      const closed = await setCapacity(app, admin, slot.id, 0).expect(200);
      expect(closed.body.capacity).toBe(0);
      let [seen] = await listSlots(app, user, {
        locationId: singapore.id,
        date: slot.localDate,
      }).then((slots) => slots.filter((s) => s.id === slot.id));
      expect(seen).toMatchObject({ capacity: 0, available: 0 });

      await http(app).post('/slots/generate').set('Authorization', bearer(admin.token)).expect(201);
      [seen] = await listSlots(app, user, {
        locationId: singapore.id,
        date: slot.localDate,
      }).then((slots) => slots.filter((s) => s.id === slot.id));
      expect(seen.capacity).toBe(0);

      await setCapacity(app, admin, slot.id, 3).expect(200);
    });

    it.each([
      ['above the global maximum', 4, 400],
      ['negative', -1, 400],
      ['not an integer', 1.5, 400],
    ])('rejects a capacity that is %s', async (_label, capacity, status) => {
      await setCapacity(app, admin, sgSlots[11].id, capacity).expect(status);
    });

    it('404s an unknown slot and 400s a malformed id', async () => {
      await setCapacity(app, admin, randomUUID(), 1).expect(404);
      await http(app)
        .patch('/slots/not-a-uuid')
        .set('Authorization', bearer(admin.token))
        .send({ capacity: 1 })
        .expect(400);
    });
  });
});
