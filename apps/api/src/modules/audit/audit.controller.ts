import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ReservationAudit } from '@lib/database';
import { JwtAuthGuard } from '@app/api/modules/auth/jwt-auth.guard';
import { Roles } from '@app/api/modules/auth/roles.decorator';
import { RolesGuard } from '@app/api/modules/auth/roles.guard';
import { ListAuditDto } from './dto/list-audit.dto';
import { AuditService } from './audit.service';

@ApiTags('audit')
@ApiBearerAuth()
@Controller('audit')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /** Admin only. See `ListAuditDto` for the filters and paging. */
  @ApiOperation({
    summary: 'Reservation history from the audit log (admin only)',
    description:
      'Every reservation event (requested, confirmed, cancelled, slot released), oldest first. ' +
      'Filter by at least one of reservationId, userId or slotId. Entries are recorded from Kafka, ' +
      'so a change made a moment ago may not be listed yet.',
  })
  @Get()
  find(@Query() query: ListAuditDto): Promise<ReservationAudit[]> {
    return this.audit.find(query);
  }
}
