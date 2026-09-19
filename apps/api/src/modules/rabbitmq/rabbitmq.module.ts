import { Module } from '@nestjs/common';
import {
  rabbitmqChannelProvider,
  rabbitmqConnectionProvider,
  RABBITMQ_CHANNEL,
  RABBITMQ_CONNECTION,
} from './rabbitmq-connection.provider';
import { RabbitmqShutdownService } from './rabbitmq-shutdown.service';

@Module({
  providers: [rabbitmqConnectionProvider, rabbitmqChannelProvider, RabbitmqShutdownService],
  exports: [RABBITMQ_CONNECTION, RABBITMQ_CHANNEL],
})
export class RabbitmqModule {}
