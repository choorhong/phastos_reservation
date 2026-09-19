import { IsDateString, IsInt, IsUUID, Min } from 'class-validator';

export class CreateSlotDto {
  @IsUUID()
  locationId: string;

  @IsDateString()
  startTime: string;

  @IsDateString()
  endTime: string;

  @IsInt()
  @Min(1)
  capacity: number;
}
