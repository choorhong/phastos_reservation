import {
  renderCancellationEmail,
  renderConfirmationEmail,
  renderReceiptEmail,
  renderReminderEmail,
} from './notification-emails';

describe('notification emails', () => {
  const booking = {
    reservationId: 'r1',
    locationName: 'Orchard Road',
    locationAddress: '270 Orchard Rd, Singapore 238857',
    timezone: 'Asia/Singapore',
    slotStartTime: new Date('2026-09-21T02:00:00Z'),
    slotEndTime: new Date('2026-09-21T04:00:00Z'),
  };

  it('puts the reservation ID second, then location, address and local date/time', () => {
    const email = renderConfirmationEmail(booking);
    expect(email.subject).toBe('Your booking at Orchard Road is confirmed');
    expect(email.text.split('\n')).toEqual([
      'Your booking at Orchard Road is confirmed.',
      'Reservation ID: r1',
      'Location: Orchard Road',
      'Address: 270 Orchard Rd, Singapore 238857',
      'Date/Time: 2026-09-21, 10:00–12:00 (Asia/Singapore)',
    ]);
  });

  it('uses the same details block in the reminder', () => {
    const lines = renderReminderEmail(booking).text.split('\n');
    expect(lines[1]).toBe('Reservation ID: r1');
    expect(lines).toContain('Date/Time: 2026-09-21, 10:00–12:00 (Asia/Singapore)');
  });

  it("adds the confirmed-at time to the receipt, on the location's clock", () => {
    const email = renderReceiptEmail({ ...booking, confirmedAt: new Date('2026-09-20T15:30:00Z') });
    const lines = email.text.split('\n');
    expect(lines[1]).toBe('Reservation ID: r1');
    expect(lines[lines.length - 1]).toBe('Confirmed at: 2026-09-20 23:30 (Asia/Singapore)');
  });

  it('says the user cancelled, with the same details block and the local cancel time', () => {
    const email = renderCancellationEmail({
      ...booking,
      cancelledAt: new Date('2026-09-20T15:30:00Z'),
      byStaff: false,
    });
    expect(email.subject).toBe('Your booking at Orchard Road is cancelled');
    expect(email.text.split('\n')).toEqual([
      'Your booking at Orchard Road has been cancelled, as you requested.',
      'Reservation ID: r1',
      'Location: Orchard Road',
      'Address: 270 Orchard Rd, Singapore 238857',
      'Date/Time: 2026-09-21, 10:00–12:00 (Asia/Singapore)',
      'Cancelled at: 2026-09-20 23:30 (Asia/Singapore)',
    ]);
  });

  it('says staff cancelled when an admin did', () => {
    const email = renderCancellationEmail({
      ...booking,
      cancelledAt: new Date('2026-09-20T15:30:00Z'),
      byStaff: true,
    });
    expect(email.text.split('\n')[0]).toBe(
      'Your booking at Orchard Road has been cancelled by our staff.',
    );
  });

  it('escapes the location name and address in the HTML body', () => {
    const email = renderConfirmationEmail({
      ...booking,
      locationName: 'A & <B>',
      locationAddress: '1 "Main" St',
    });
    expect(email.html).toContain('A &amp; &lt;B&gt;');
    expect(email.html).toContain('1 &quot;Main&quot; St');
    expect(email.html).not.toContain('<B>');
  });
});
