import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ClsService } from 'nestjs-cls';
import { Logger } from 'nestjs-pino';
import { Repository } from 'typeorm';
import { Reservation, Slot } from '@lib/database';
import { AuthenticatedUser } from '@app/api/modules/auth/auth.types';
import { EventsPublisherService } from '@app/api/modules/events/events-publisher.service';
import { NotificationsPublisherService } from '@app/api/modules/notifications/notifications-publisher.service';
import { HoldExpiredError, SlotSoldOutError } from '@app/api/modules/slots/slot-hold.errors';
import { SlotHoldService } from '@app/api/modules/slots/slot-hold.service';
import { CancelReservationDto } from './dto/cancel-reservation.dto';
import { CreateReservationDto } from './dto/create-reservation.dto';

/**
 * Ties the four independently-verified infrastructure legs (Redis hold,
 * Postgres row of record, Kafka lifecycle events, RabbitMQ notifications)
 * into the actual reservation lifecycle, per PLAN.md §4's direct-vs-queue
 * split: the Redis/Postgres/Kafka calls are synchronous and gate the HTTP
 * response, the RabbitMQ enqueues are fire-and-forget side effects that
 * must never turn an otherwise-successful booking into an error response.
 */
@Injectable()
export class ReservationsService {
  constructor(
    @InjectRepository(Reservation) private readonly reservations: Repository<Reservation>,
    @InjectRepository(Slot) private readonly slots: Repository<Slot>,
    private readonly slotHoldService: SlotHoldService,
    private readonly events: EventsPublisherService,
    private readonly notifications: NotificationsPublisherService,
    private readonly cls: ClsService,
    private readonly logger: Logger,
  ) {}

  async requestHold(dto: CreateReservationDto, userId: string): Promise<Reservation> {
    const correlationId = this.cls.getId();

    const slot = await this.slots.findOne({ where: { id: dto.slotId } });
    if (!slot) {
      throw new NotFoundException(`Slot ${dto.slotId} not found`);
    }

    let hold;
    try {
      hold = await this.slotHoldService.claim(dto.slotId, userId);
    } catch (err) {
      if (err instanceof SlotSoldOutError) {
        throw new ConflictException(err.message);
      }
      throw err;
    }

    const reservation = await this.reservations.save(
      this.reservations.create({
        slotId: slot.id,
        userId,
        holdId: hold.holdId,
        status: 'held',
        correlationId,
      }),
    );

    try {
      await this.events.publishReservationRequested(
        { slotId: slot.id, locationId: slot.locationId, correlationId },
        {
          reservationId: reservation.id,
          userId: reservation.userId,
          holdId: hold.holdId,
          requestedAt: reservation.createdAt.toISOString(),
        },
      );
    } catch (err) {
      this.logger.warn(
        { err, reservationId: reservation.id },
        'reservation.requested_event_publish_failed',
      );
    }

    return reservation;
  }

  async confirm(reservationId: string, currentUser: AuthenticatedUser): Promise<Reservation> {
    const correlationId = this.cls.getId();

    const reservation = await this.reservations.findOne({
      where: { id: reservationId },
      relations: ['slot', 'slot.location'],
    });
    if (!reservation) {
      throw new NotFoundException(`Reservation ${reservationId} not found`);
    }
    this.assertOwnerOrAdmin(reservation, currentUser);
    if (reservation.status === 'confirmed') {
      return reservation;
    }
    if (reservation.status !== 'held') {
      throw new ConflictException(
        `Reservation ${reservationId} is ${reservation.status}, cannot confirm`,
      );
    }

    try {
      await this.slotHoldService.confirm(reservation.slotId, reservation.holdId);
    } catch (err) {
      if (err instanceof HoldExpiredError) {
        reservation.status = 'expired';
        await this.reservations.save(reservation);
        throw new GoneException(err.message);
      }
      throw err;
    }

    reservation.status = 'confirmed';
    reservation.confirmedAt = new Date();
    await this.reservations.save(reservation);

    const slot = reservation.slot;
    const eventCtx = { slotId: slot.id, locationId: slot.locationId, correlationId };

    try {
      await this.events.publishReservationConfirmed(eventCtx, {
        reservationId: reservation.id,
        userId: reservation.userId,
        confirmedAt: reservation.confirmedAt.toISOString(),
        slotStartTime: slot.startTime.toISOString(),
        slotEndTime: slot.endTime.toISOString(),
      });
    } catch (err) {
      this.logger.warn({ err, reservationId }, 'reservation.confirmed_event_publish_failed');
    }

    try {
      await this.notifications.publishConfirmationEmail(
        {
          reservationId: reservation.id,
          userId: reservation.userId,
          locationName: slot.location.name,
          slotStartTime: slot.startTime.toISOString(),
          slotEndTime: slot.endTime.toISOString(),
        },
        correlationId,
      );
      await this.notifications.publishReceipt(
        {
          reservationId: reservation.id,
          userId: reservation.userId,
          confirmedAt: reservation.confirmedAt.toISOString(),
        },
        correlationId,
      );
    } catch (err) {
      this.logger.warn({ err, reservationId }, 'reservation.confirm_notifications_publish_failed');
    }

    return reservation;
  }

  async cancel(
    reservationId: string,
    dto: CancelReservationDto,
    currentUser: AuthenticatedUser,
  ): Promise<Reservation> {
    const correlationId = this.cls.getId();

    const reservation = await this.reservations.findOne({
      where: { id: reservationId },
      relations: ['slot'],
    });
    if (!reservation) {
      throw new NotFoundException(`Reservation ${reservationId} not found`);
    }
    this.assertOwnerOrAdmin(reservation, currentUser);
    if (reservation.status === 'cancelled') {
      return reservation;
    }
    if (reservation.status !== 'held' && reservation.status !== 'confirmed') {
      throw new ConflictException(
        `Reservation ${reservationId} is ${reservation.status}, cannot cancel`,
      );
    }

    // Safe for both statuses: on a still-live hold this releases it and
    // returns the pending unit of capacity; on a confirmed reservation the
    // hold key is already gone (confirm deleted it) so those steps are
    // no-ops, but the capacity that confirm consumed permanently is
    // returned to the pool via the same INCR (see redis-hold.scripts.ts).
    await this.slotHoldService.release(reservation.slotId, reservation.holdId);

    reservation.status = 'cancelled';
    reservation.cancelledAt = new Date();
    reservation.cancelReason = dto.reason ?? 'user_cancelled';
    await this.reservations.save(reservation);

    const eventCtx = {
      slotId: reservation.slotId,
      locationId: reservation.slot.locationId,
      correlationId,
    };

    try {
      await this.events.publishReservationCancelled(eventCtx, {
        reservationId: reservation.id,
        userId: reservation.userId,
        cancelledAt: reservation.cancelledAt.toISOString(),
        reason: reservation.cancelReason,
      });
      await this.events.publishSlotReleased(eventCtx, {
        slotId: reservation.slotId,
        releasedCapacity: 1,
        reason: 'cancellation',
      });
    } catch (err) {
      this.logger.warn({ err, reservationId }, 'reservation.cancelled_event_publish_failed');
    }

    return reservation;
  }

  /** Admins can act on any reservation; a regular user only on their own. */
  private assertOwnerOrAdmin(reservation: Reservation, currentUser: AuthenticatedUser): void {
    if (currentUser.role !== 'admin' && reservation.userId !== currentUser.userId) {
      throw new ForbiddenException(`Reservation ${reservation.id} does not belong to this user`);
    }
  }
}
