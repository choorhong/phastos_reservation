import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import type { AmqpConnectionManager, ChannelWrapper } from 'amqp-connection-manager';
import { RABBITMQ_CHANNEL, RABBITMQ_CONNECTION } from './rabbitmq-connection.provider';

/** Closes the channel and connection on shutdown (the providers are bare factories). */
@Injectable()
export class RabbitmqShutdownService implements OnApplicationShutdown {
  constructor(
    @Inject(RABBITMQ_CHANNEL) private readonly channel: ChannelWrapper,
    @Inject(RABBITMQ_CONNECTION) private readonly connection: AmqpConnectionManager,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.channel.close();
    await this.connection.close();
  }
}
