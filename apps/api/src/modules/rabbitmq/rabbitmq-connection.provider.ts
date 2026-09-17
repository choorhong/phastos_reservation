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
    // amqp-connection-manager handles reconnect/backoff on its own, which is
    // the reason it's used here instead of raw amqplib (PLAN.md §4: these
    // queues sit in front of slow/unreliable third parties, so the broker
    // connection itself needs to be resilient too).
    return amqp.connect([`amqp://${user}:${password}@${host}:${port}`]);
  },
};

/**
 * A single shared channel whose `setup` (re-)asserts the notification
 * exchanges/queues/DLQs on every (re)connect -- `assertNotificationsTopology`
 * is idempotent, so this is safe to run again after a broker reconnect.
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
