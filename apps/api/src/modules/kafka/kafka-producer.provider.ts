import { Provider } from '@nestjs/common';
import { Kafka, Producer } from 'kafkajs';
import { AppConfigService } from '@lib/config';
import { ensureReservationEventsTopic } from '@lib/kafka-contracts';

export const KAFKA_PRODUCER = Symbol('KAFKA_PRODUCER');

export const kafkaProducerProvider: Provider = {
  provide: KAFKA_PRODUCER,
  inject: [AppConfigService],
  useFactory: async (config: AppConfigService): Promise<Producer> => {
    const kafka = new Kafka({
      clientId: config.get('KAFKA_CLIENT_ID'),
      brokers: config.get('KAFKA_BROKERS').split(','),
    });

    // Whichever process (api or event-consumer) boots first creates the
    // topic -- ensureReservationEventsTopic is idempotent, same pattern as
    // assertNotificationsTopology for RabbitMQ.
    const admin = kafka.admin();
    await admin.connect();
    await ensureReservationEventsTopic(admin, config.get('KAFKA_TOPIC_REPLICATION_FACTOR'));
    await admin.disconnect();

    const producer = kafka.producer();
    await producer.connect();
    return producer;
  },
};
