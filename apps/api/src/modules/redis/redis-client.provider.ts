import { Provider } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '@lib/config';
import { attachHoldScripts } from '@lib/redis-scripts';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
export const REDIS_SUBSCRIBER_CLIENT = Symbol('REDIS_SUBSCRIBER_CLIENT');

export const redisClientProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [AppConfigService],
  useFactory: (config: AppConfigService): Redis => {
    const redis = new Redis({
      host: config.get('REDIS_HOST'),
      port: config.get('REDIS_PORT'),
    });
    return attachHoldScripts(redis);
  },
};

/**
 * A separate connection for keyspace-notification `SUBSCRIBE` (the hold
 * reaper's fast path, docs/architecture.md §2). ioredis puts a connection that issues
 * SUBSCRIBE into a dedicated pub/sub mode where it can no longer run
 * ordinary commands, so it can't share a connection with REDIS_CLIENT.
 */
export const redisSubscriberClientProvider: Provider = {
  provide: REDIS_SUBSCRIBER_CLIENT,
  inject: [AppConfigService],
  useFactory: (config: AppConfigService): Redis =>
    new Redis({
      host: config.get('REDIS_HOST'),
      port: config.get('REDIS_PORT'),
    }),
};
