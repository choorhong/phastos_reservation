import { Module } from '@nestjs/common';
import {
  redisClientProvider,
  redisSubscriberClientProvider,
  REDIS_CLIENT,
  REDIS_SUBSCRIBER_CLIENT,
} from './redis-client.provider';
import { RedisShutdownService } from './redis-shutdown.service';

@Module({
  providers: [redisClientProvider, redisSubscriberClientProvider, RedisShutdownService],
  exports: [REDIS_CLIENT, REDIS_SUBSCRIBER_CLIENT],
})
export class RedisModule {}
