import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import type { Producer } from 'kafkajs';
import { KAFKA_PRODUCER } from './kafka-producer.provider';

/** Closes the producer's broker connections on shutdown (the provider is a bare factory). */
@Injectable()
export class KafkaShutdownService implements OnApplicationShutdown {
  constructor(@Inject(KAFKA_PRODUCER) private readonly producer: Producer) {}

  async onApplicationShutdown(): Promise<void> {
    await this.producer.disconnect();
  }
}
