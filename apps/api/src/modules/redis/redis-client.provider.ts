import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { attachHoldScripts } from '@app/redis-scripts';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
export const REDIS_SUBSCRIBER_CLIENT = Symbol('REDIS_SUBSCRIBER_CLIENT');

export const redisClientProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Redis => {
    const redis = new Redis({
      host: config.get<string>('REDIS_HOST', 'localhost'),
      port: config.get<number>('REDIS_PORT', 6379),
    });
    return attachHoldScripts(redis);
  },
};

/**
 * A separate connection for keyspace-notification `SUBSCRIBE` (the hold
 * reaper's fast path, PLAN.md §2). ioredis puts a connection that issues
 * SUBSCRIBE into a dedicated pub/sub mode where it can no longer run
 * ordinary commands, so it can't share a connection with REDIS_CLIENT.
 */
export const redisSubscriberClientProvider: Provider = {
  provide: REDIS_SUBSCRIBER_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Redis =>
    new Redis({
      host: config.get<string>('REDIS_HOST', 'localhost'),
      port: config.get<number>('REDIS_PORT', 6379),
    }),
};
