import { ApiPropertyOptional } from '@nestjs/swagger';
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
  // The CLI plugin stringifies the @Matches RegExp with its enclosing `/../`
  // slashes into the OpenAPI `pattern` keyword, which doesn't use them --
  // Swagger UI's own client-side check then requires a literal `/` in the
  // input, which no real date has, so every date blocks in "Try it out"
  // before the request is even sent. Override with the same pattern minus
  // the slashes; server-side validation (the @Matches decorator above) is
  // unaffected by this, it's a docs-only fix.
  @ApiPropertyOptional({ pattern: '^\\d{4}-\\d{2}-\\d{2}$', example: '2026-09-22' })
  date?: string;

  /** Defaults to now if omitted -- past slots aren't bookable, so don't return them by default. */
  @IsOptional()
  @IsDateString()
  @ApiPropertyOptional({ example: '2026-09-22T00:00:00Z' })
  from?: string;

  @IsOptional()
  @IsDateString()
  @ApiPropertyOptional({ example: '2026-09-29T00:00:00Z' })
  to?: string;
}
