import { Location, Reservation, Slot } from '@lib/database';
import { toReservationView } from './reservation-view';

function reservationAt(timezone: string, startTime: string, endTime: string): Reservation {
  return {
    id: 'r1',
    status: 'confirmed',
    userId: 'u1',
    slotId: 's1',
    holdId: 'secret-hold',
    correlationId: 'secret-correlation',
    reminderSentAt: new Date(),
    createdAt: new Date('2026-09-19T00:00:00Z'),
    updatedAt: new Date('2026-09-19T00:00:00Z'),
    confirmedAt: new Date('2026-09-19T00:01:00Z'),
    slot: {
      id: 's1',
      startTime: new Date(startTime),
      endTime: new Date(endTime),
      location: { id: 'l1', name: 'Orchard', address: '2 Orchard Turn', timezone } as Location,
    } as Slot,
  } as Reservation;
}

describe('toReservationView', () => {
  it("puts the slot on the location's clock and names the location", () => {
    const view = toReservationView(
      reservationAt('Asia/Singapore', '2026-09-21T02:00:00Z', '2026-09-21T04:00:00Z'),
    );
    expect(view.slot).toMatchObject({
      id: 's1',
      timezone: 'Asia/Singapore',
      localDate: '2026-09-21',
      localStartTime: '10:00',
      localEndTime: '12:00',
    });
    expect(view.slot.startTime).toEqual(new Date('2026-09-21T02:00:00Z'));
    expect(view.location).toEqual({ id: 'l1', name: 'Orchard', address: '2 Orchard Turn' });
  });

  it('uses the location timezone, not the viewer or server timezone', () => {
    // Same instant as a 4am-Monday-Singapore slot is still Sunday evening in Los Angeles.
    const view = toReservationView(
      reservationAt('America/Los_Angeles', '2026-09-20T20:00:00Z', '2026-09-20T22:00:00Z'),
    );
    expect(view.slot).toMatchObject({ localDate: '2026-09-20', localStartTime: '13:00' });
  });

  it('nulls fields that are not set yet and hides internal ones', () => {
    const reservation = reservationAt(
      'Asia/Singapore',
      '2026-09-21T02:00:00Z',
      '2026-09-21T04:00:00Z',
    );
    reservation.status = 'held';
    reservation.confirmedAt = undefined;
    const view = toReservationView(reservation);
    expect(view).toMatchObject({
      status: 'held',
      confirmedAt: null,
      cancelledAt: null,
      cancelReason: null,
    });
    expect(view).not.toHaveProperty('holdId');
    expect(view).not.toHaveProperty('correlationId');
    expect(view).not.toHaveProperty('reminderSentAt');
  });

  it('throws if the slot and location were not loaded', () => {
    expect(() => toReservationView({ id: 'r1', slotId: 's1' } as Reservation)).toThrow(
      /without its slot and location/,
    );
  });
});
