import { ApiProperty } from '@nestjs/swagger';
import type { ReservationCancelReason, ReservationStatus } from '@lib/domain';
import { Reservation } from '@lib/database';
import { SlotLocalTimes, toSlotLocalTimes } from '@lib/time';

const RESERVATION_STATUSES: ReservationStatus[] = ['held', 'confirmed', 'cancelled', 'expired'];
const RESERVATION_CANCEL_REASONS: ReservationCancelReason[] = [
  'user_cancelled',
  'hold_expired',
  'admin_cancelled',
  'slot_full',
];

/** The slot half of a `ReservationView`: its UTC instants plus the location's own clock. */
export class ReservationSlotView extends SlotLocalTimes {
  @ApiProperty()
  id: string;

  @ApiProperty()
  startTime: Date;

  @ApiProperty()
  endTime: Date;
}

/** The location half of a `ReservationView`. */
export class ReservationLocationView {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  address: string;
}

/**
 * What the reservation endpoints return. Unlike the bare entity it says
 * *when* and *where* the booking is -- the slot's UTC instants plus the same
 * slot on the location's own clock (see `@lib/time`) and the location's name
 * -- so a client can show "Mon 21 Sep, 10:00-12:00 at Orchard" without a
 * second call or any timezone logic of its own. Internal fields (`holdId`,
 * `correlationId`, `reminderSentAt`) are deliberately not exposed.
 *
 * A class rather than a plain interface so it also works as an OpenAPI
 * response schema -- `toReservationView` below still returns a plain object
 * literal, never a constructed instance, so this has no effect on the
 * actual runtime value.
 */
export class ReservationView {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: RESERVATION_STATUSES })
  status: ReservationStatus;

  @ApiProperty()
  userId: string;

  @ApiProperty()
  slotId: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({ type: Date, nullable: true })
  confirmedAt: Date | null;

  @ApiProperty({ type: Date, nullable: true })
  cancelledAt: Date | null;

  @ApiProperty({ enum: RESERVATION_CANCEL_REASONS, nullable: true })
  cancelReason: ReservationCancelReason | null;

  @ApiProperty({ type: ReservationSlotView })
  slot: ReservationSlotView;

  @ApiProperty({ type: ReservationLocationView })
  location: ReservationLocationView;
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
