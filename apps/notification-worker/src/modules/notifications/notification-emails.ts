import { DateTime } from 'luxon';
import { toSlotLocalTimes } from '@lib/time';
import { escapeHtml } from '@app/notification-worker/modules/email/escape-html';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** What every notification email shows about the booking. */
export interface BookingDetails {
  reservationId: string;
  locationName: string;
  locationAddress: string;
  timezone: string; // IANA zone of the location
  slotStartTime: Date;
  slotEndTime: Date;
}

/**
 * Pure renderers for the three notification emails -- no I/O, so they're
 * unit-testable on their own. Every time is shown on the location's own
 * clock (`toSlotLocalTimes`), never UTC or the worker's zone: the user
 * needs to know when to turn up at that store.
 */

export function renderConfirmationEmail(booking: BookingDetails): RenderedEmail {
  return render(
    `Your booking at ${booking.locationName} is confirmed`,
    `Your booking at ${booking.locationName} is confirmed.`,
    booking,
  );
}

export function renderReminderEmail(booking: BookingDetails): RenderedEmail {
  return render(
    `Reminder: your booking at ${booking.locationName} is coming up`,
    `This is a reminder of your upcoming booking at ${booking.locationName}.`,
    booking,
  );
}

export function renderReceiptEmail(booking: BookingDetails & { confirmedAt: Date }): RenderedEmail {
  const confirmedAt = DateTime.fromJSDate(booking.confirmedAt, { zone: booking.timezone }).toFormat(
    'yyyy-MM-dd HH:mm',
  );
  return render(
    `Receipt for your booking at ${booking.locationName}`,
    `Receipt for your booking at ${booking.locationName}.`,
    booking,
    [`Confirmed at: ${confirmedAt} (${booking.timezone})`],
  );
}

/** Intro line, then the reservation ID, then where and when, then any extra lines. */
function render(
  subject: string,
  intro: string,
  booking: BookingDetails,
  extraLines: string[] = [],
): RenderedEmail {
  const local = toSlotLocalTimes(booking.timezone, booking.slotStartTime, booking.slotEndTime);
  const lines = [
    intro,
    `Reservation ID: ${booking.reservationId}`,
    `Location: ${booking.locationName}`,
    `Address: ${booking.locationAddress}`,
    `Date/Time: ${local.localDate}, ${local.localStartTime}–${local.localEndTime} (${local.timezone})`,
    ...extraLines,
  ];
  return {
    subject,
    text: lines.join('\n'),
    html: lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('\n'),
  };
}
