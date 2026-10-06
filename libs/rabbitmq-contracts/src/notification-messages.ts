import { randomUUID } from 'crypto';
import type { Channel, ConfirmChannel } from 'amqplib';
import type { ChannelWrapper } from 'amqp-connection-manager';
import type { ReservationCancelReason } from '@lib/domain';

/**
 * The notification task queues from docs/architecture.md §4 ("RabbitMQ vs Direct
 * Calls"): slow/unreliable side effects that must never block the request
 * that triggered them, and need retry + DLQ instead of just failing once.
 */
export type NotificationQueueName =
  'confirmation-email' | 'reminder' | 'receipt' | 'cancellation-email';

export const NOTIFICATION_QUEUE_NAMES: readonly NotificationQueueName[] = [
  'confirmation-email',
  'reminder',
  'receipt',
  'cancellation-email',
];

interface NotificationEnvelope<T extends NotificationQueueName, P> {
  messageId: string; // UUID v4, set once at publish time -- dedupe/idempotency key downstream
  queue: T;
  correlationId: string;
  createdAt: string; // ISO 8601
  payload: P;
}

export interface ConfirmationEmailPayload {
  reservationId: string;
  userId: string;
  locationName: string;
  timezone: string; // IANA zone of the location; the slot times below are UTC instants
  slotStartTime: string; // ISO 8601
  slotEndTime: string; // ISO 8601
}

export interface ReminderPayload {
  reservationId: string;
  userId: string;
  locationName: string;
  timezone: string; // IANA zone of the location; the slot time below is a UTC instant
  slotStartTime: string; // ISO 8601
}

export interface ReceiptPayload {
  reservationId: string;
  userId: string;
  confirmedAt: string; // ISO 8601
}

/**
 * Only for a booking that had been confirmed (the user was told they had
 * it), cancelled by the user or an admin. Not sent for a hold cancelled
 * before confirming, nor for a confirm refused because the slot was full.
 */
export interface CancellationEmailPayload {
  reservationId: string;
  userId: string;
  cancelledAt: string; // ISO 8601
  reason: Extract<ReservationCancelReason, 'user_cancelled' | 'admin_cancelled'>;
}

export type NotificationMessage =
  | NotificationEnvelope<'confirmation-email', ConfirmationEmailPayload>
  | NotificationEnvelope<'reminder', ReminderPayload>
  | NotificationEnvelope<'receipt', ReceiptPayload>
  | NotificationEnvelope<'cancellation-email', CancellationEmailPayload>;

/**
 * Header carrying the number of prior delivery attempts. The consumer reads
 * it, and on failure either republishes with it incremented (retry) or, once
 * it reaches MAX, nacks without requeue so the queue's own
 * x-dead-letter-exchange routes the message to its DLQ (docs/architecture.md §4: "after N
 * retries move to DLQ and alert rather than loop forever").
 */
export const RETRY_COUNT_HEADER = 'x-retry-count';

export const NOTIFICATIONS_EXCHANGE = 'notifications';
export const NOTIFICATIONS_DLX = 'notifications.dlx';

export function notificationQueueName(queue: NotificationQueueName): string {
  return `q.${queue}`;
}

export function notificationDlqName(queue: NotificationQueueName): string {
  return `q.${queue}.dlq`;
}

/**
 * Declares the exchanges/queues/bindings for all the notification queues
 * plus their matching DLQs. Idempotent (plain `assert*`/`bindQueue` calls),
 * so both `apps/api` (producer) and `apps/notification-worker` (consumer)
 * can safely run this against the same broker on startup.
 */
export async function assertNotificationsTopology(
  channel: Channel | ConfirmChannel,
): Promise<void> {
  await channel.assertExchange(NOTIFICATIONS_EXCHANGE, 'direct', { durable: true });
  await channel.assertExchange(NOTIFICATIONS_DLX, 'direct', { durable: true });

  for (const queue of NOTIFICATION_QUEUE_NAMES) {
    const mainQueue = notificationQueueName(queue);
    const dlq = notificationDlqName(queue);

    await channel.assertQueue(mainQueue, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': NOTIFICATIONS_DLX,
        'x-dead-letter-routing-key': queue,
      },
    });
    await channel.bindQueue(mainQueue, NOTIFICATIONS_EXCHANGE, queue);

    await channel.assertQueue(dlq, { durable: true });
    await channel.bindQueue(dlq, NOTIFICATIONS_DLX, queue);
  }
}

/**
 * Envelopes and publishes a notification message. Shared by both
 * `apps/api` (confirmation-email, receipt) and
 * `apps/notification-worker`'s reminder sweep (reminder) so the
 * envelope/header shape can't drift between producers -- each app supplies
 * its own `ChannelWrapper` (connection/channel setup stays app-local, see
 * each app's `modules/rabbitmq`), this just builds the message.
 */
export async function publishNotification<T extends NotificationQueueName>(
  channel: ChannelWrapper,
  queue: T,
  payload: Extract<NotificationMessage, { queue: T }>['payload'],
  correlationId: string,
): Promise<string> {
  const messageId = randomUUID();
  const envelope: NotificationEnvelope<T, typeof payload> = {
    messageId,
    queue,
    correlationId,
    createdAt: new Date().toISOString(),
    payload,
  };

  await channel.publish(
    NOTIFICATIONS_EXCHANGE,
    queue,
    Buffer.from(JSON.stringify(envelope), 'utf8'),
    {
      persistent: true,
      contentType: 'application/json',
      messageId,
      correlationId,
      headers: { [RETRY_COUNT_HEADER]: 0 },
    },
  );

  return messageId;
}
