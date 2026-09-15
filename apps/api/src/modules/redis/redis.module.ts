import { Module } from '@nestjs/common';
import {
  redisClientProvider,
  redisSubscriberClientProvider,
  REDIS_CLIENT,
  REDIS_SUBSCRIBER_CLIENT,
} from './redis-client.provider';

@Module({
  providers: [redisClientProvider, redisSubscriberClientProvider],
  exports: [REDIS_CLIENT, REDIS_SUBSCRIBER_CLIENT],
})
export class RedisModule {}
