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
import { In, QueryFailedError, Repository } from 'typeorm';
import { ACTIVE_RESERVATION_UNIQUE_INDEX, Reservation, Slot } from '@lib/database';
import { AuthenticatedUser } from '@app/api/modules/auth/auth.types';
import { EventsPublisherService } from '@app/api/modules/events/events-publisher.service';
import { NotificationsPublisherService } from '@app/api/modules/notifications/notifications-publisher.service';
import { HoldExpiredError, SlotSoldOutError } from '@app/api/modules/slots/slot-hold.errors';
import { SlotHold, SlotHoldService } from '@app/api/modules/slots/slot-hold.service';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { ListReservationsDto } from './dto/list-reservations.dto';
import { ReservationView, toReservationView } from './reservation-view';

/** Postgres unique violation on the one-active-reservation-per-user-per-slot index. */
function isActiveReservationConflict(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) {
    return false;
  }
  const { code, constraint } = err.driverError as { code?: string; constraint?: string };
  return code === '23505' && constraint === ACTIVE_RESERVATION_UNIQUE_INDEX;
}

/**
 * Ties the four independently-verified infrastructure legs (Redis hold,
 * Postgres row of record, Kafka lifecycle events, RabbitMQ notifications)
 * into the actual reservation lifecycle, per docs/architecture.md §4's direct-vs-queue
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

  async requestHold(dto: CreateReservationDto, userId: string): Promise<ReservationView> {
    const correlationId = this.cls.getId();

    const slot = await this.slots.findOne({
      where: { id: dto.slotId },
      relations: ['location'],
    });
    if (!slot) {
      throw new NotFoundException(`Slot ${dto.slotId} not found`);
    }

    // One spot per person per slot. Checked before the Redis claim so a repeat
    // request costs nothing; the unique index below catches the concurrent case.
    const alreadyBooked = await this.reservations.exists({
      where: { slotId: slot.id, userId, status: In(['held', 'confirmed']) },
    });
    if (alreadyBooked) {
      throw new ConflictException(`You already have a reservation for slot ${slot.id}`);
    }

    let hold: SlotHold;
    try {
      hold = await this.slotHoldService.claim(dto.slotId, userId);
    } catch (err) {
      if (err instanceof SlotSoldOutError) {
        throw new ConflictException(err.message);
      }
      throw err;
    }

    let reservation: Reservation;
    try {
      reservation = await this.reservations.save(
        this.reservations.create({
          slotId: slot.id,
          userId,
          holdId: hold.holdId,
          status: 'held',
          correlationId,
        }),
      );
    } catch (err) {
      if (isActiveReservationConflict(err)) {
        // Two requests from this user raced past the check above. The claim
        // already took a spot in Redis, so give it back.
        await this.slotHoldService.release(slot.id, hold.holdId);
        throw new ConflictException(`You already have a reservation for slot ${slot.id}`);
      }
      throw err;
    }

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

    reservation.slot = slot;
    return toReservationView(reservation);
  }

  /** The caller's own reservations, soonest slot first. Admins see only their own here too. */
  async listForUser(userId: string, query: ListReservationsDto): Promise<ReservationView[]> {
    const reservations = await this.reservations.find({
      where: { userId, ...(query.status && { status: query.status }) },
      relations: ['slot', 'slot.location'],
      order: { slot: { startTime: 'ASC' } },
    });
    return reservations.map(toReservationView);
  }

  async findOne(reservationId: string, currentUser: AuthenticatedUser): Promise<ReservationView> {
    const reservation = await this.reservations.findOne({
      where: { id: reservationId },
      relations: ['slot', 'slot.location'],
    });
    if (!reservation) {
      throw new NotFoundException(`Reservation ${reservationId} not found`);
    }
    this.assertOwnerOrAdmin(reservation, currentUser);
    return toReservationView(reservation);
  }

  async confirm(reservationId: string, currentUser: AuthenticatedUser): Promise<ReservationView> {
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
      return toReservationView(reservation);
    }
    if (reservation.status === 'expired') {
      // The reaper already expired the hold: same answer as a late confirm always got.
      throw new GoneException(`Hold for reservation ${reservationId} has expired`);
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
        reservation.cancelReason = 'hold_expired';
        await this.reservations.save(reservation);
        throw new GoneException(err.message);
      }
      throw err;
    }

    reservation.status = 'confirmed';
    reservation.confirmedAt = new Date();
    try {
      await this.reservations.save(reservation);
    } catch (err) {
      throw await this.rejectConfirmIfSlotFull(err, reservation, correlationId);
    }

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
          timezone: slot.location.timezone,
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

    return toReservationView(reservation);
  }

  async cancel(reservationId: string, currentUser: AuthenticatedUser): Promise<ReservationView> {
    const correlationId = this.cls.getId();

    const reservation = await this.reservations.findOne({
      where: { id: reservationId },
      relations: ['slot', 'slot.location'],
    });
    if (!reservation) {
      throw new NotFoundException(`Reservation ${reservationId} not found`);
    }
    this.assertOwnerOrAdmin(reservation, currentUser);
    if (reservation.status === 'cancelled') {
      return toReservationView(reservation);
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

    // Only a booking the user was told they had gets a cancellation email.
    const wasConfirmed = reservation.status === 'confirmed';
    reservation.status = 'cancelled';
    reservation.cancelledAt = new Date();
    // Who cancelled comes from the caller's token, never the request: an
    // admin cancelling someone else's booking is 'admin_cancelled'; the
    // owner (an admin cancelling their own booking too) is 'user_cancelled'.
    reservation.cancelReason =
      currentUser.role === 'admin' && currentUser.userId !== reservation.userId
        ? 'admin_cancelled'
        : 'user_cancelled';
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

    if (wasConfirmed) {
      try {
        await this.notifications.publishCancellationEmail(
          {
            reservationId: reservation.id,
            userId: reservation.userId,
            cancelledAt: reservation.cancelledAt.toISOString(),
            reason: reservation.cancelReason,
          },
          correlationId,
        );
      } catch (err) {
        this.logger.warn({ err, reservationId }, 'reservation.cancel_notification_publish_failed');
      }
    }

    return toReservationView(reservation);
  }

  /**
   * Redis said there was room but Postgres's `enforce_slot_capacity` trigger
   * disagrees (Redis was stale or lost): Postgres wins. The reservation can
   * never be confirmed, so it is cancelled instead of being left `held`
   * (nothing would ever clean it up: its Redis hold is already consumed), and
   * the caller gets a 409 rather than a bare 500. Any other error is passed on.
   *
   * Publishes `ReservationCancelled` (reason `slot_full`) so consumers see the
   * lifecycle end, but no `SlotReleased`: no capacity comes back, since
   * Postgres never counted this reservation and the stale Redis counter is
   * deliberately left alone.
   */
  private async rejectConfirmIfSlotFull(
    err: unknown,
    reservation: Reservation,
    correlationId: string,
  ): Promise<unknown> {
    if (!(err instanceof QueryFailedError) || !err.message.includes('SLOT_CAPACITY_EXCEEDED')) {
      return err;
    }
    // A targeted update: the in-memory entity still carries the confirmedAt
    // set above, which must not reach the row.
    const cancelledAt = new Date();
    await this.reservations.update(
      { id: reservation.id },
      { status: 'cancelled', cancelledAt, cancelReason: 'slot_full' },
    );
    this.logger.warn(
      { reservationId: reservation.id, slotId: reservation.slotId },
      'reservation.confirm_rejected_slot_full',
    );

    try {
      await this.events.publishReservationCancelled(
        { slotId: reservation.slotId, locationId: reservation.slot.locationId, correlationId },
        {
          reservationId: reservation.id,
          userId: reservation.userId,
          cancelledAt: cancelledAt.toISOString(),
          reason: 'slot_full',
        },
      );
    } catch (publishErr) {
      this.logger.warn(
        { err: publishErr, reservationId: reservation.id },
        'reservation.cancelled_event_publish_failed',
      );
    }

    return new ConflictException(`Slot ${reservation.slotId} is already full`);
  }

  /** Admins can act on any reservation; a regular user only on their own. */
  private assertOwnerOrAdmin(reservation: Reservation, currentUser: AuthenticatedUser): void {
    if (currentUser.role !== 'admin' && reservation.userId !== currentUser.userId) {
      throw new ForbiddenException(`Reservation ${reservation.id} does not belong to this user`);
    }
  }
}
