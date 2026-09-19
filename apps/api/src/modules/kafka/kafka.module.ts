import { Module } from '@nestjs/common';
import { kafkaProducerProvider, KAFKA_PRODUCER } from './kafka-producer.provider';
import { KafkaShutdownService } from './kafka-shutdown.service';

@Module({
  providers: [kafkaProducerProvider, KafkaShutdownService],
  exports: [KAFKA_PRODUCER],
})
export class KafkaModule {}
