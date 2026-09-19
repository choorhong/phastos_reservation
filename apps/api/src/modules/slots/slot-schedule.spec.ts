import { assertValidSlotRule, buildSlotWindows, SlotRule } from './slot-schedule';

const rule: SlotRule = { openHour: 10, closeHour: 18, durationHours: 2, windowDays: 30 };

const iso = (windows: { startTime: Date; endTime: Date }[]) =>
  windows.map((w) => `${w.startTime.toISOString()}/${w.endTime.toISOString()}`);

describe('buildSlotWindows', () => {
  // Saturday 2026-09-19 12:00 UTC.
  const saturday = new Date('2026-09-19T12:00:00Z');

  it('skips the weekend and starts on Monday with four 2h slots', () => {
    const windows = buildSlotWindows('Asia/Singapore', { ...rule, windowDays: 2 }, saturday);
    expect(iso(windows)).toEqual([
      '2026-09-21T02:00:00.000Z/2026-09-21T04:00:00.000Z', // Mon 10:00-12:00 SGT
      '2026-09-21T04:00:00.000Z/2026-09-21T06:00:00.000Z',
      '2026-09-21T06:00:00.000Z/2026-09-21T08:00:00.000Z',
      '2026-09-21T08:00:00.000Z/2026-09-21T10:00:00.000Z', // Mon 16:00-18:00 SGT
    ]);
  });

  it('only ever produces Monday-Friday slots in the location timezone', () => {
    const windows = buildSlotWindows('America/Los_Angeles', rule, saturday);
    expect(windows.length).toBe(21 * 4); // 21 weekdays from Sat 19 Sep through Mon 19 Oct
    for (const w of windows) {
      const weekday = new Date(
        w.startTime.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }),
      ).getDay();
      expect(weekday).toBeGreaterThanOrEqual(1);
      expect(weekday).toBeLessThanOrEqual(5);
    }
  });

  it('keeps the local hours across a daylight-saving change', () => {
    // LA falls back on Sun 2026-11-01: Fri 10:00 is PDT (17:00Z), Mon 10:00 is PST (18:00Z).
    const windows = buildSlotWindows(
      'America/Los_Angeles',
      { ...rule, windowDays: 5 },
      new Date('2026-10-30T07:00:00Z'), // Fri 00:00 PDT
    );
    const starts = iso(windows).map((w) => w.split('/')[0]);
    expect(starts).toContain('2026-10-30T17:00:00.000Z');
    expect(starts).toContain('2026-11-02T18:00:00.000Z');
  });

  it('never back-fills slots that have already started', () => {
    // Mon 2026-09-21 13:00 SGT: the 10:00 and 12:00 slots are past, 14:00 and 16:00 remain.
    const windows = buildSlotWindows(
      'Asia/Singapore',
      { ...rule, windowDays: 0 },
      new Date('2026-09-21T05:00:00Z'),
    );
    expect(iso(windows).map((w) => w.split('/')[0])).toEqual([
      '2026-09-21T06:00:00.000Z',
      '2026-09-21T08:00:00.000Z',
    ]);
  });

  it("uses the location's own 'today', not the server's", () => {
    // 2026-09-20 20:00 UTC is Sunday in LA but already Monday 04:00 in Singapore.
    const now = new Date('2026-09-20T20:00:00Z');
    const la = buildSlotWindows('America/Los_Angeles', { ...rule, windowDays: 0 }, now);
    const sg = buildSlotWindows('Asia/Singapore', { ...rule, windowDays: 0 }, now);
    expect(la).toEqual([]);
    expect(sg).toHaveLength(4);
  });

  it('throws on an invalid timezone', () => {
    expect(() => buildSlotWindows('Mars/Olympus', rule, saturday)).toThrow(/Invalid timezone/);
  });
});

describe('assertValidSlotRule', () => {
  it('accepts the 10-18 / 2h rule', () => {
    expect(() => assertValidSlotRule(rule)).not.toThrow();
  });

  it.each([
    [{ closeHour: 17 }, /divide evenly/],
    [{ closeHour: 10 }, /after SLOT_OPEN_HOUR/],
    [{ durationHours: 0 }, /SLOT_DURATION_HOURS/],
    [{ windowDays: 0 }, /SLOT_WINDOW_DAYS/],
    [{ openHour: 10.5 }, /SLOT_OPEN_HOUR/],
  ])('rejects %j', (override, message) => {
    expect(() => assertValidSlotRule({ ...rule, ...override })).toThrow(message);
  });
});
