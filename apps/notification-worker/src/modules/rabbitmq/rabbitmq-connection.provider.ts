import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqp-connection-manager';
import type { AmqpConnectionManager, ChannelWrapper } from 'amqp-connection-manager';
import { assertNotificationsTopology } from '@lib/rabbitmq-contracts';

export const RABBITMQ_CONNECTION = Symbol('RABBITMQ_CONNECTION');
export const RABBITMQ_CHANNEL = Symbol('RABBITMQ_CHANNEL');

export const rabbitmqConnectionProvider: Provider = {
  provide: RABBITMQ_CONNECTION,
  inject: [ConfigService],
  useFactory: (config: ConfigService): AmqpConnectionManager => {
    const host = config.get<string>('RABBITMQ_HOST', 'localhost');
    const port = config.get<number>('RABBITMQ_PORT', 5672);
    const user = config.get<string>('RABBITMQ_USER', 'guest');
    const password = config.get<string>('RABBITMQ_PASSWORD', 'guest');
    return amqp.connect([`amqp://${user}:${password}@${host}:${port}`]);
  },
};

/**
 * `assertNotificationsTopology` is idempotent, so notification-worker
 * re-asserting the same exchanges/queues/DLQs that apps/api's producer side
 * already declared is safe -- whichever process starts first wins, and both
 * ends of the queue agree on its shape either way.
 */
export const rabbitmqChannelProvider: Provider = {
  provide: RABBITMQ_CHANNEL,
  inject: [RABBITMQ_CONNECTION],
  useFactory: (connection: AmqpConnectionManager): ChannelWrapper =>
    connection.createChannel({
      json: false,
      setup: assertNotificationsTopology,
    }),
};
