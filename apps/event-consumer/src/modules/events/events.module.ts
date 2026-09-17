import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProcessedEvent } from '@lib/database';
import { KafkaModule } from '@app/event-consumer/modules/kafka/kafka.module';
import { EventsConsumerService } from './events-consumer.service';

@Module({
  imports: [KafkaModule, TypeOrmModule.forFeature([ProcessedEvent])],
  providers: [EventsConsumerService],
})
export class EventsModule {}
