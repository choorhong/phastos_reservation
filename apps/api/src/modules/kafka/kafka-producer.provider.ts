import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, Producer } from 'kafkajs';
import { ensureReservationEventsTopic } from '@lib/kafka-contracts';

export const KAFKA_PRODUCER = Symbol('KAFKA_PRODUCER');

export const kafkaProducerProvider: Provider = {
  provide: KAFKA_PRODUCER,
  inject: [ConfigService],
  useFactory: async (config: ConfigService): Promise<Producer> => {
    const kafka = new Kafka({
      clientId: config.get<string>('KAFKA_CLIENT_ID', 'phastos-reservation'),
      brokers: config.get<string>('KAFKA_BROKERS', 'localhost:9092').split(','),
    });

    // Whichever process (api or event-consumer) boots first creates the
    // topic -- ensureReservationEventsTopic is idempotent, same pattern as
    // assertNotificationsTopology for RabbitMQ.
    const admin = kafka.admin();
    await admin.connect();
    await ensureReservationEventsTopic(
      admin,
      config.get<number>('KAFKA_TOPIC_REPLICATION_FACTOR', 1),
    );
    await admin.disconnect();

    const producer = kafka.producer();
    await producer.connect();
    return producer;
  },
};
