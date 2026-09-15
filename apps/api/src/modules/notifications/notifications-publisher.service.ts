import { Inject, Injectable } from '@nestjs/common';
import type { ChannelWrapper } from 'amqp-connection-manager';
import {
  ConfirmationEmailPayload,
  publishNotification,
  ReceiptPayload,
  ReminderPayload,
} from '@app/rabbitmq-contracts';
import { RABBITMQ_CHANNEL } from '../rabbitmq/rabbitmq-connection.provider';

/**
 * Publishes the three notification task messages (PLAN.md §4). These are
 * "direct producer calls" in PLAN.md's terms -- called synchronously from
 * within the request path but only to hand the message to RabbitMQ, not to
 * wait on delivery -- so the request is never blocked by SendGrid/SES or PDF
 * generation.
 */
@Injectable()
export class NotificationsPublisherService {
  constructor(@Inject(RABBITMQ_CHANNEL) private readonly channel: ChannelWrapper) {}

  async publishConfirmationEmail(
    payload: ConfirmationEmailPayload,
    correlationId: string,
  ): Promise<void> {
    await publishNotification(this.channel, 'confirmation-email', payload, correlationId);
  }

  async publishReminder(payload: ReminderPayload, correlationId: string): Promise<void> {
    await publishNotification(this.channel, 'reminder', payload, correlationId);
  }

  async publishReceipt(payload: ReceiptPayload, correlationId: string): Promise<void> {
    await publishNotification(this.channel, 'receipt', payload, correlationId);
  }
}
