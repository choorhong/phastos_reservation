import { IsString, IsUUID } from 'class-validator';

export class CreateReservationDto {
  @IsUUID()
  slotId: string;

  @IsString()
  userId: string;
}
