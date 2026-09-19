import type { ReservationCancelReason, ReservationStatus } from '@lib/domain';
import { Reservation } from '@lib/database';
import { SlotLocalTimes, toSlotLocalTimes } from '@lib/time';

/**
 * What the reservation endpoints return. Unlike the bare entity it says
 * *when* and *where* the booking is -- the slot's UTC instants plus the same
 * slot on the location's own clock (see `@lib/time`) and the location's name
 * -- so a client can show "Mon 21 Sep, 10:00-12:00 at Orchard" without a
 * second call or any timezone logic of its own. Internal fields (`holdId`,
 * `correlationId`, `reminderSentAt`) are deliberately not exposed.
 */
export interface ReservationView {
  id: string;
  status: ReservationStatus;
  userId: string;
  slotId: string;
  createdAt: Date;
  confirmedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: ReservationCancelReason | null;
  slot: { id: string; startTime: Date; endTime: Date } & SlotLocalTimes;
  location: { id: string; name: string; address: string };
}

/** `reservation.slot.location` must be loaded. */
export function toReservationView(reservation: Reservation): ReservationView {
  const { slot } = reservation;
  const location = slot?.location;
  if (!location) {
    throw new Error(`Reservation ${reservation.id} was mapped without its slot and location`);
  }
  return {
    id: reservation.id,
    status: reservation.status,
    userId: reservation.userId,
    slotId: reservation.slotId,
    createdAt: reservation.createdAt,
    confirmedAt: reservation.confirmedAt ?? null,
    cancelledAt: reservation.cancelledAt ?? null,
    cancelReason: reservation.cancelReason ?? null,
    slot: {
      id: slot.id,
      startTime: slot.startTime,
      endTime: slot.endTime,
      ...toSlotLocalTimes(location.timezone, slot.startTime, slot.endTime),
    },
    location: { id: location.id, name: location.name, address: location.address },
  };
}
