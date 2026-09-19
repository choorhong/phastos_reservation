import { DateTime } from 'luxon';

export interface SlotLocalTimes {
  /** The location's IANA timezone the fields below are expressed in. */
  timezone: string;
  /** `YYYY-MM-DD`, the calendar day of the slot's start in `timezone`. */
  localDate: string;
  /** `HH:mm` (24-hour) in `timezone`. */
  localStartTime: string;
  localEndTime: string;
}

function inZone(instant: Date, timezone: string): DateTime {
  const value = DateTime.fromJSDate(instant, { zone: timezone });
  if (!value.isValid) {
    throw new Error(`Invalid timezone "${timezone}": ${value.invalidExplanation}`);
  }
  return value;
}

/**
 * A slot is stored as UTC instants; this is the same slot as the location's
 * own clock shows it. Computed on the way out, never stored: it is derived
 * from the instant plus `locations.timezone`, so it can't drift if a
 * timezone is corrected or its daylight-saving rules change.
 */
export function toSlotLocalTimes(timezone: string, startTime: Date, endTime: Date): SlotLocalTimes {
  const start = inZone(startTime, timezone);
  return {
    timezone,
    localDate: start.toFormat('yyyy-MM-dd'),
    localStartTime: start.toFormat('HH:mm'),
    localEndTime: inZone(endTime, timezone).toFormat('HH:mm'),
  };
}

/**
 * The UTC range `[start, end)` covering one calendar day (`YYYY-MM-DD`) in
 * `timezone` -- 23 or 25 hours long on a daylight-saving change. Lets a
 * "slots on this local date" filter use the plain `start_time` index.
 * Returns `null` if `date` isn't a real calendar date.
 */
export function localDayRange(date: string, timezone: string): { start: Date; end: Date } | null {
  const day = DateTime.fromISO(date, { zone: timezone }).startOf('day');
  if (!day.isValid) {
    if (DateTime.local().setZone(timezone).isValid) {
      return null;
    }
    throw new Error(`Invalid timezone "${timezone}"`);
  }
  return { start: day.toJSDate(), end: day.plus({ days: 1 }).toJSDate() };
}
