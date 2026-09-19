import { IsDateString, IsOptional, IsUUID, Matches } from 'class-validator';

export class ListSlotsDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  /**
   * One calendar day, `YYYY-MM-DD`, in the location's own timezone. Needs
   * `locationId` (a date means different instants in different timezones)
   * and can't be combined with `from`/`to`.
   */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;

  /** Defaults to now if omitted -- past slots aren't bookable, so don't return them by default. */
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
