import { IsIn, IsOptional } from 'class-validator';
import type { ReservationCancelReason } from '@lib/domain';

const USER_FACING_CANCEL_REASONS: ReservationCancelReason[] = ['user_cancelled', 'admin_cancelled'];

export class CancelReservationDto {
  @IsOptional()
  @IsIn(USER_FACING_CANCEL_REASONS)
  reason?: ReservationCancelReason;
}
