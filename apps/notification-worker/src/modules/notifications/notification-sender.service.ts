import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Reservation, User } from '@lib/database';
import type { NotificationMessage } from '@lib/rabbitmq-contracts';
import { EmailService } from '@app/notification-worker/modules/email/email.service';
import {
  BookingDetails,
  renderConfirmationEmail,
  renderReceiptEmail,
  renderReminderEmail,
  RenderedEmail,
} from './notification-emails';

/**
 * Turns one notification envelope into one sent email. The recipient's
 * address is looked up in Postgres by `userId` rather than carried on the
 * queue, so the address is never copied into RabbitMQ (or its DLQs) and a
 * changed address is picked up by any send that hasn't happened yet. The
 * booking details (location name and address, slot times) are read from
 * the reservation the same way: the queue payloads don't carry the address,
 * and the receipt payload carries no slot or location at all.
 *
 * Any failure (unknown user/reservation, Resend error) throws, which the
 * consumer turns into a retry and finally a dead-letter.
 */
@Injectable()
export class NotificationSenderService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Reservation) private readonly reservations: Repository<Reservation>,
    private readonly email: EmailService,
  ) {}

  async send(envelope: NotificationMessage): Promise<string> {
    const { userId, reservationId } = envelope.payload;
    const user = await this.users.findOneBy({ id: userId });
    if (!user) {
      throw new Error(`User ${userId} not found`);
    }
    const reservation = await this.reservations.findOne({
      where: { id: reservationId },
      relations: { slot: { location: true } },
    });
    if (!reservation) {
      throw new Error(`Reservation ${reservationId} not found`);
    }

    const rendered = render(envelope, {
      reservationId: reservation.id,
      locationName: reservation.slot.location.name,
      locationAddress: reservation.slot.location.address,
      timezone: reservation.slot.location.timezone,
      slotStartTime: reservation.slot.startTime,
      slotEndTime: reservation.slot.endTime,
    });
    return this.email.send({ to: user.email, ...rendered, idempotencyKey: envelope.messageId });
  }
}

function render(envelope: NotificationMessage, booking: BookingDetails): RenderedEmail {
  switch (envelope.queue) {
    case 'confirmation-email':
      return renderConfirmationEmail(booking);
    case 'reminder':
      return renderReminderEmail(booking);
    case 'receipt':
      return renderReceiptEmail({
        ...booking,
        confirmedAt: new Date(envelope.payload.confirmedAt),
      });
  }
}
