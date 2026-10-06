import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, IsUUID, Max, Min } from 'class-validator';

export const AUDIT_DEFAULT_LIMIT = 100;
export const AUDIT_MAX_LIMIT = 500;

/**
 * At least one of `reservationId`, `userId`, `slotId` is required (checked
 * in `AuditService`); given several, an entry must match all of them.
 * Entries come oldest first. To page through more than `limit`, pass the
 * last entry's `occurredAt` as `from` (entries at exactly that instant are
 * returned again).
 */
export class ListAuditDto {
  @IsOptional()
  @IsUUID()
  reservationId?: string;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsUUID()
  slotId?: string;

  /** Only entries that occurred at or after this instant. */
  @IsOptional()
  @IsISO8601({ strict: true })
  @ApiPropertyOptional({ example: '2026-10-01T00:00:00Z' })
  from?: string;

  /** Only entries that occurred before this instant. */
  @IsOptional()
  @IsISO8601({ strict: true })
  @ApiPropertyOptional({ example: '2026-11-01T00:00:00Z' })
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(AUDIT_MAX_LIMIT)
  @ApiPropertyOptional({ default: AUDIT_DEFAULT_LIMIT, maximum: AUDIT_MAX_LIMIT })
  limit?: number;
}
