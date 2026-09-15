import { Module } from '@nestjs/common';
import { KafkaModule } from '../kafka/kafka.module';
import { EventsPublisherService } from './events-publisher.service';

@Module({
  imports: [KafkaModule],
  providers: [EventsPublisherService],
  exports: [EventsPublisherService],
})
export class EventsModule {}
