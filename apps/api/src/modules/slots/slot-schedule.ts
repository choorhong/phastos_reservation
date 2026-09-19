import { DateTime } from 'luxon';

export interface SlotRule {
  /** Local wall-clock hour the first slot starts, 0-23. */
  openHour: number;
  /** Local wall-clock hour the last slot ends, 1-23. */
  closeHour: number;
  durationHours: number;
  /** Slots are built for today plus this many following days. */
  windowDays: number;
}

export interface SlotWindow {
  startTime: Date;
  endTime: Date;
}

/** Luxon ISO weekdays: Monday = 1 ... Friday = 5. */
const WEEKDAYS = [1, 2, 3, 4, 5];

/** Throws a descriptive error if the rule can't produce a whole number of slots per day. */
export function assertValidSlotRule(rule: SlotRule): void {
  const { openHour, closeHour, durationHours, windowDays } = rule;
  const problems: string[] = [];
  if (!Number.isInteger(openHour) || openHour < 0 || openHour > 22) {
    problems.push('SLOT_OPEN_HOUR must be an integer from 0 to 22');
  }
  if (!Number.isInteger(closeHour) || closeHour < 1 || closeHour > 23) {
    problems.push('SLOT_CLOSE_HOUR must be an integer from 1 to 23');
  }
  if (!Number.isInteger(durationHours) || durationHours < 1) {
    problems.push('SLOT_DURATION_HOURS must be a positive integer');
  }
  if (!Number.isInteger(windowDays) || windowDays < 1) {
    problems.push('SLOT_WINDOW_DAYS must be a positive integer');
  }
  if (problems.length === 0) {
    if (closeHour <= openHour) {
      problems.push('SLOT_CLOSE_HOUR must be after SLOT_OPEN_HOUR');
    } else if ((closeHour - openHour) % durationHours !== 0) {
      problems.push(
        'SLOT_DURATION_HOURS must divide evenly into the SLOT_OPEN_HOUR-SLOT_CLOSE_HOUR span',
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(`Invalid slot rule: ${problems.join('; ')}`);
  }
}

/**
 * Every slot that should exist for a location: weekdays only, from today
 * (in the location's own timezone) through `windowDays` days ahead. Hours
 * are wall-clock in `timezone`, so a daylight-saving change moves the UTC
 * instants but not the local opening hours. Slots that have already started
 * are left out -- past days are never back-filled.
 */
export function buildSlotWindows(timezone: string, rule: SlotRule, now: Date): SlotWindow[] {
  const today = DateTime.fromJSDate(now, { zone: timezone }).startOf('day');
  if (!today.isValid) {
    throw new Error(`Invalid timezone "${timezone}": ${today.invalidExplanation}`);
  }

  const windows: SlotWindow[] = [];
  for (let offset = 0; offset <= rule.windowDays; offset++) {
    const day = today.plus({ days: offset });
    if (!WEEKDAYS.includes(day.weekday)) {
      continue;
    }
    for (let hour = rule.openHour; hour < rule.closeHour; hour += rule.durationHours) {
      const start = day.set({ hour });
      if (start.toMillis() <= now.getTime()) {
        continue;
      }
      windows.push({
        startTime: start.toJSDate(),
        endTime: day.set({ hour: hour + rule.durationHours }).toJSDate(),
      });
    }
  }
  return windows;
}
