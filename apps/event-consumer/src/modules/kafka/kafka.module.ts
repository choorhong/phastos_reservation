import { Module } from '@nestjs/common';
import { kafkaConsumerProvider, KAFKA_CONSUMER } from './kafka-consumer.provider';

@Module({
  providers: [kafkaConsumerProvider],
  exports: [KAFKA_CONSUMER],
})
export class KafkaModule {}
