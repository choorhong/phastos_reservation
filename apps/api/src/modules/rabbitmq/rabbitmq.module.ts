import { Module } from '@nestjs/common';
import {
  rabbitmqChannelProvider,
  rabbitmqConnectionProvider,
  RABBITMQ_CHANNEL,
  RABBITMQ_CONNECTION,
} from './rabbitmq-connection.provider';

@Module({
  providers: [rabbitmqConnectionProvider, rabbitmqChannelProvider],
  exports: [RABBITMQ_CONNECTION, RABBITMQ_CHANNEL],
})
export class RabbitmqModule {}
