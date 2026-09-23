import type { ConsumeMessage } from 'amqplib';
import { NOTIFICATIONS_EXCHANGE, RETRY_COUNT_HEADER } from '@lib/rabbitmq-contracts';
import { NotificationConsumersService } from './notification-consumers.service';

function consumeMessage(
  payload: Record<string, unknown>,
  headers: Record<string, unknown> = {},
): ConsumeMessage {
  return {
    content: Buffer.from(JSON.stringify(payload), 'utf8'),
    properties: {
      headers,
      contentType: 'application/json',
      messageId: 'm1',
      correlationId: 'c1',
    },
  } as ConsumeMessage;
}

const validEnvelope = {
  messageId: 'm1',
  queue: 'confirmation-email',
  correlationId: 'c1',
  createdAt: new Date().toISOString(),
  payload: { reservationId: 'r1', userId: 'u1' },
};

// Missing `reservationId` -- the one failure mode processMessage() actually checks for.
const malformedEnvelope = { ...validEnvelope, payload: { userId: 'u1' } };

describe('NotificationConsumersService retry/DLQ policy', () => {
  const channel = { consume: jest.fn(), ack: jest.fn(), nack: jest.fn(), publish: jest.fn() };
  // NOTIFICATION_MAX_RETRIES read once in the constructor -- set before it runs, below.
  const config = { get: jest.fn().mockReturnValue(3) };
  const logger = { log: jest.fn(), warn: jest.fn() };
  const service = new NotificationConsumersService(
    channel as never,
    config as never,
    logger as never,
  );

  // Private, but it's the actual retry/DLQ logic under test -- onModuleInit only wires
  // it up to channel.consume, which adds nothing worth re-proving here.
  const handleMessage = (queue: string, msg: ConsumeMessage) =>
    (
      service as unknown as { handleMessage(q: string, m: ConsumeMessage): Promise<void> }
    ).handleMessage(queue, msg);

  beforeEach(() => {
    jest.resetAllMocks();
    channel.publish.mockResolvedValue(undefined);
  });

  it('acks and logs a well-formed message', async () => {
    const msg = consumeMessage(validEnvelope);
    await handleMessage('confirmation-email', msg);

    expect(channel.ack).toHaveBeenCalledWith(msg);
    expect(channel.nack).not.toHaveBeenCalled();
    expect(channel.publish).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: 'confirmation-email',
        messageId: 'm1',
        correlationId: 'c1',
      }),
      'notification.delivered',
    );
  });

  it('retries a malformed message by republishing with an incremented retry header, and acks the original delivery', async () => {
    const msg = consumeMessage(malformedEnvelope, { [RETRY_COUNT_HEADER]: 1 });
    await handleMessage('confirmation-email', msg);

    expect(channel.nack).not.toHaveBeenCalled();
    expect(channel.ack).toHaveBeenCalledWith(msg);
    expect(channel.publish).toHaveBeenCalledWith(
      NOTIFICATIONS_EXCHANGE,
      'confirmation-email',
      msg.content,
      expect.objectContaining({ headers: expect.objectContaining({ [RETRY_COUNT_HEADER]: 2 }) }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ queue: 'confirmation-email', retryCount: 2 }),
      'notification.retry_scheduled',
    );
  });

  it('treats a message with no retry header yet as attempt 0, retrying to 1', async () => {
    const msg = consumeMessage(malformedEnvelope);
    await handleMessage('confirmation-email', msg);

    expect(channel.publish).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ headers: expect.objectContaining({ [RETRY_COUNT_HEADER]: 1 }) }),
    );
  });

  it('dead-letters instead of retrying once NOTIFICATION_MAX_RETRIES is reached', async () => {
    const msg = consumeMessage(malformedEnvelope, { [RETRY_COUNT_HEADER]: 2 }); // 2 + 1 >= maxRetries (3)
    await handleMessage('confirmation-email', msg);

    expect(channel.publish).not.toHaveBeenCalled();
    expect(channel.ack).not.toHaveBeenCalled();
    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ queue: 'confirmation-email', retryCount: 2 }),
      'notification.dead_lettered',
    );
  });
});
