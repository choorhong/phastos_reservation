import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Logger } from 'nestjs-pino';
import { randomUUID } from 'crypto';
import type { ChannelWrapper } from 'amqp-connection-manager';
import { Between, IsNull, Repository } from 'typeorm';
import { Reservation } from '@app/database';
import { publishNotification } from '@app/rabbitmq-contracts';
import { RABBITMQ_CHANNEL } from '../rabbitmq/rabbitmq-connection.provider';

const SWEEP_INTERVAL_NAME = 'reminder-sweep';

/**
 * The DB-scheduler-sweep half of PLAN.md "Decisions" #2: periodically scans
 * `reservations` for confirmed rows whose slot starts within the reminder
 * lead window and enqueues each to RabbitMQ's `reminder` queue, instead of
 * using the `rabbitmq-delayed-message-exchange` plugin -- reminders are
 * hours-to-a-day out (too long/variable a delay to hold in a queue), and a
 * DB sweep naturally skips reservations cancelled in the meantime since
 * they no longer match the query.
 *
 * `reminder_sent_at IS NULL` is both the sweep's query filter and its
 * claim: `claimReminder` does a conditional `UPDATE ... WHERE
 * reminder_sent_at IS NULL` before publishing, so two overlapping sweep
 * ticks (or, once this runs on more than one instance, two instances) can't
 * both enqueue the same reminder.
 */
@Injectable()
export class ReminderSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly reminderLeadMinutes: number;

  constructor(
    @InjectRepository(Reservation) private readonly reservations: Repository<Reservation>,
    @Inject(RABBITMQ_CHANNEL) private readonly channel: ChannelWrapper,
    private readonly config: ConfigService,
    private readonly scheduler: SchedulerRegistry,
    private readonly logger: Logger,
  ) {
    this.reminderLeadMinutes = this.config.get<number>('REMINDER_LEAD_MINUTES', 60);
  }

  onModuleInit(): void {
    const sweepIntervalMs = this.config.get<number>('REMINDER_SWEEP_INTERVAL_MS', 60_000);
    const handle = setInterval(() => void this.sweep(), sweepIntervalMs);
    this.scheduler.addInterval(SWEEP_INTERVAL_NAME, handle);
  }

  onModuleDestroy(): void {
    if (this.scheduler.doesExist('interval', SWEEP_INTERVAL_NAME)) {
      this.scheduler.deleteInterval(SWEEP_INTERVAL_NAME);
    }
  }

  private async sweep(): Promise<void> {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + this.reminderLeadMinutes * 60_000);

    const candidates = await this.reservations.find({
      where: {
        status: 'confirmed',
        reminderSentAt: IsNull(),
        slot: { startTime: Between(now, windowEnd) },
      },
      relations: { slot: { location: true } },
    });

    for (const reservation of candidates) {
      await this.claimAndSendReminder(reservation);
    }
  }

  private async claimAndSendReminder(reservation: Reservation): Promise<void> {
    const claim = await this.reservations.update(
      { id: reservation.id, reminderSentAt: IsNull() },
      { reminderSentAt: new Date() },
    );
    if (claim.affected !== 1) {
      return; // another sweep tick/instance already claimed this one
    }

    const correlationId = reservation.correlationId ?? randomUUID();
    await publishNotification(
      this.channel,
      'reminder',
      {
        reservationId: reservation.id,
        userId: reservation.userId,
        locationName: reservation.slot.location.name,
        slotStartTime: reservation.slot.startTime.toISOString(),
      },
      correlationId,
    );
    this.logger.log(
      { reservationId: reservation.id, slotId: reservation.slotId, correlationId },
      'reminder.sweep.enqueued',
    );
  }
}
