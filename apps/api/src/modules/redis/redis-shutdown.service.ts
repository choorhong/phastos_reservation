import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT, REDIS_SUBSCRIBER_CLIENT } from './redis-client.provider';

/**
 * Closes both Redis connections on shutdown (the providers are bare
 * factories). Runs at `onApplicationShutdown`, after every module's own
 * `onModuleDestroy` -- e.g. the hold reaper's unsubscribe needs the
 * subscriber connection still open.
 */
@Injectable()
export class RedisShutdownService implements OnApplicationShutdown {
  constructor(
    @Inject(REDIS_CLIENT) private readonly client: Redis,
    @Inject(REDIS_SUBSCRIBER_CLIENT) private readonly subscriber: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.client.quit(), this.subscriber.quit()]);
  }
}
