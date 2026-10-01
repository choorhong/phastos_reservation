import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import type { ChannelWrapper } from 'amqp-connection-manager';
import type { ConsumeMessage } from 'amqplib';
import { AppConfigService } from '@lib/config';
import {
  NOTIFICATION_QUEUE_NAMES,
  NOTIFICATIONS_EXCHANGE,
  NotificationMessage,
  NotificationQueueName,
  notificationQueueName,
  RETRY_COUNT_HEADER,
} from '@lib/rabbitmq-contracts';
import { RABBITMQ_CHANNEL } from '@app/notification-worker/modules/rabbitmq/rabbitmq-connection.provider';
import { NotificationSenderService } from './notification-sender.service';

/**
 * Consumes the three notification queues (docs/architecture.md §4): each
 * message is validated, then sent as an email via Resend
 * (`NotificationSenderService`). Around that, the retry/DLQ mechanics: on a
 * processing failure (malformed payload, unknown user, Resend error), retry up to NOTIFICATION_MAX_RETRIES
 * times by republishing with an incremented `x-retry-count` header, then
 * nack-without-requeue so the queue's own `x-dead-letter-exchange` routes
 * the message to its DLQ -- "after N retries move to DLQ and alert rather
 * than loop forever."
 */
@Injectable()
export class NotificationConsumersService implements OnModuleInit {
  private readonly maxRetries: number;

  constructor(
    @Inject(RABBITMQ_CHANNEL) private readonly channel: ChannelWrapper,
    private readonly config: AppConfigService,
    private readonly sender: NotificationSenderService,
    private readonly logger: Logger,
  ) {
    this.maxRetries = this.config.get('NOTIFICATION_MAX_RETRIES');
  }

  async onModuleInit(): Promise<void> {
    for (const queue of NOTIFICATION_QUEUE_NAMES) {
      await this.channel.consume(
        notificationQueueName(queue),
        (msg) => void this.handleMessage(queue, msg),
        { noAck: false },
      );
    }
  }

  private async handleMessage(queue: NotificationQueueName, msg: ConsumeMessage): Promise<void> {
    const retryCount = Number(msg.properties.headers?.[RETRY_COUNT_HEADER] ?? 0);

    try {
      const envelope = JSON.parse(msg.content.toString('utf8')) as NotificationMessage;
      validateMessage(envelope);
      const emailId = await this.sender.send(envelope);
      this.channel.ack(msg);
      this.logger.log(
        { queue, messageId: envelope.messageId, correlationId: envelope.correlationId, emailId },
        'notification.delivered',
      );
    } catch (err) {
      await this.handleFailure(queue, msg, retryCount, err as Error);
    }
  }

  private async handleFailure(
    queue: NotificationQueueName,
    msg: ConsumeMessage,
    retryCount: number,
    err: Error,
  ): Promise<void> {
    if (retryCount + 1 >= this.maxRetries) {
      this.channel.nack(msg, false, false); // routes to the queue's DLX -- terminal
      this.logger.warn(
        { queue, retryCount, error: err.message, messageId: msg.properties.messageId },
        'notification.dead_lettered',
      );
      return;
    }

    await this.channel.publish(NOTIFICATIONS_EXCHANGE, queue, msg.content, {
      persistent: true,
      contentType: msg.properties.contentType,
      messageId: msg.properties.messageId,
      correlationId: msg.properties.correlationId,
      headers: { ...msg.properties.headers, [RETRY_COUNT_HEADER]: retryCount + 1 },
    });
    this.channel.ack(msg); // original delivery is replaced by the republished retry, above
    this.logger.warn(
      {
        queue,
        retryCount: retryCount + 1,
        error: err.message,
        messageId: msg.properties.messageId,
      },
      'notification.retry_scheduled',
    );
  }
}

/**
 * Throws on a structurally invalid envelope before anything is looked up
 * or sent -- it goes down the same retry/DLQ path as a send failure.
 */
function validateMessage(envelope: NotificationMessage): void {
  if (!envelope.payload || !envelope.payload.reservationId || !envelope.payload.userId) {
    throw new Error(`Malformed ${envelope.queue} payload: missing reservationId/userId`);
  }
}
