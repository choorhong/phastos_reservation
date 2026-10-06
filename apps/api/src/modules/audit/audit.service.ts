import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ReservationAudit } from '@lib/database';
import { AUDIT_DEFAULT_LIMIT, ListAuditDto } from './dto/list-audit.dto';

/**
 * Reads `reservation_audit`, which event-consumer fills from the Kafka
 * events. The api never writes it. A just-made change can take a moment to
 * appear, since it travels through Kafka first.
 */
@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(ReservationAudit) private readonly audit: Repository<ReservationAudit>,
  ) {}

  find(query: ListAuditDto): Promise<ReservationAudit[]> {
    if (!query.reservationId && !query.userId && !query.slotId) {
      throw new BadRequestException('Give at least one of reservationId, userId or slotId');
    }

    const qb = this.audit.createQueryBuilder('a');
    if (query.reservationId) {
      qb.andWhere('a.reservation_id = :reservationId', { reservationId: query.reservationId });
    }
    if (query.userId) {
      qb.andWhere('a.user_id = :userId', { userId: query.userId });
    }
    if (query.slotId) {
      qb.andWhere('a.slot_id = :slotId', { slotId: query.slotId });
    }
    if (query.from) {
      qb.andWhere('a.occurred_at >= :from', { from: query.from });
    }
    if (query.to) {
      qb.andWhere('a.occurred_at < :to', { to: query.to });
    }
    return qb
      .orderBy('a.occurred_at', 'ASC')
      .addOrderBy('a.event_id', 'ASC')
      .take(query.limit ?? AUDIT_DEFAULT_LIMIT)
      .getMany();
  }
}
