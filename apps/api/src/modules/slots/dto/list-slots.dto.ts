import { IsDateString, IsOptional, IsUUID } from 'class-validator';

export class ListSlotsDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  /** Defaults to now if omitted -- past slots aren't bookable, so don't return them by default. */
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
