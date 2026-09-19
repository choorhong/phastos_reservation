import { localDayRange, toSlotLocalTimes } from './slot-local-time';

describe('toSlotLocalTimes', () => {
  it("shows a Singapore slot on Singapore's clock", () => {
    expect(
      toSlotLocalTimes(
        'Asia/Singapore',
        new Date('2026-09-21T02:00:00Z'),
        new Date('2026-09-21T04:00:00Z'),
      ),
    ).toEqual({
      timezone: 'Asia/Singapore',
      localDate: '2026-09-21',
      localStartTime: '10:00',
      localEndTime: '12:00',
    });
  });

  it("shows a Santa Monica slot on Los Angeles' clock, even when it ends on the next UTC day", () => {
    expect(
      toSlotLocalTimes(
        'America/Los_Angeles',
        new Date('2026-09-21T23:00:00Z'),
        new Date('2026-09-22T01:00:00Z'),
      ),
    ).toMatchObject({ localDate: '2026-09-21', localStartTime: '16:00', localEndTime: '18:00' });
  });

  it('does not depend on the timezone of the machine converting it', () => {
    // The same instant is a different local date in the two locations.
    const instant = new Date('2026-09-21T20:00:00Z');
    expect(toSlotLocalTimes('America/Los_Angeles', instant, instant).localDate).toBe('2026-09-21');
    expect(toSlotLocalTimes('Asia/Singapore', instant, instant).localDate).toBe('2026-09-22');
  });

  it('throws on an invalid timezone', () => {
    const now = new Date();
    expect(() => toSlotLocalTimes('Mars/Olympus', now, now)).toThrow(/Invalid timezone/);
  });
});

describe('localDayRange', () => {
  it('spans one local day in UTC', () => {
    expect(localDayRange('2026-09-21', 'Asia/Singapore')).toEqual({
      start: new Date('2026-09-20T16:00:00Z'),
      end: new Date('2026-09-21T16:00:00Z'),
    });
    expect(localDayRange('2026-09-21', 'America/Los_Angeles')).toEqual({
      start: new Date('2026-09-21T07:00:00Z'),
      end: new Date('2026-09-22T07:00:00Z'),
    });
  });

  it('is 25 hours long when the clocks go back and 23 when they go forward', () => {
    const hours = (date: string) => {
      const range = localDayRange(date, 'America/Los_Angeles')!;
      return (range.end.getTime() - range.start.getTime()) / 3_600_000;
    };
    expect(hours('2026-11-01')).toBe(25);
    expect(hours('2026-03-08')).toBe(23);
  });

  it('returns null for a date that does not exist', () => {
    expect(localDayRange('2026-02-30', 'Asia/Singapore')).toBeNull();
    expect(localDayRange('nonsense', 'Asia/Singapore')).toBeNull();
  });

  it('throws on an invalid timezone', () => {
    expect(() => localDayRange('2026-09-21', 'Mars/Olympus')).toThrow(/Invalid timezone/);
  });
});
