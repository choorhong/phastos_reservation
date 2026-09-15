import { Module } from '@nestjs/common';
import { kafkaProducerProvider, KAFKA_PRODUCER } from './kafka-producer.provider';

@Module({
  providers: [kafkaProducerProvider],
  exports: [KAFKA_PRODUCER],
})
export class KafkaModule {}
