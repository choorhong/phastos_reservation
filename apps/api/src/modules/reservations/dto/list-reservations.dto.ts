import { IsIn, IsOptional } from 'class-validator';
import type { ReservationStatus } from '@lib/domain';

const RESERVATION_STATUSES: ReservationStatus[] = ['held', 'confirmed', 'cancelled', 'expired'];

export class ListReservationsDto {
  /** Only reservations in this status; all of the caller's reservations if omitted. */
  @IsOptional()
  @IsIn(RESERVATION_STATUSES)
  status?: ReservationStatus;
}
