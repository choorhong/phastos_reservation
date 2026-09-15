import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProcessedEvent } from '@app/database';
import { KafkaModule } from '@/modules/kafka/kafka.module';
import { EventsConsumerService } from './events-consumer.service';

@Module({
  imports: [KafkaModule, TypeOrmModule.forFeature([ProcessedEvent])],
  providers: [EventsConsumerService],
})
export class EventsModule {}
