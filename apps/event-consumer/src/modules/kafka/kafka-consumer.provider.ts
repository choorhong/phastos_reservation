import { Provider } from '@nestjs/common';
import { Consumer, Kafka } from 'kafkajs';
import { AppConfigService } from '@lib/config';
import { ensureReservationEventsTopic, RESERVATION_EVENTS_TOPIC } from '@lib/kafka-contracts';

export const KAFKA_CONSUMER = Symbol('KAFKA_CONSUMER');

export const kafkaConsumerProvider: Provider = {
  provide: KAFKA_CONSUMER,
  inject: [AppConfigService],
  useFactory: async (config: AppConfigService): Promise<Consumer> => {
    const kafka = new Kafka({
      clientId: config.get('KAFKA_CLIENT_ID'),
      brokers: config.get('KAFKA_BROKERS'),
    });

    const admin = kafka.admin();
    await admin.connect();
    await ensureReservationEventsTopic(admin, config.get('KAFKA_TOPIC_REPLICATION_FACTOR'));
    await admin.disconnect();

    const consumer = kafka.consumer({
      groupId: config.get('EVENT_CONSUMER_GROUP_ID'),
    });
    await consumer.connect();
    await consumer.subscribe({ topic: RESERVATION_EVENTS_TOPIC, fromBeginning: false });
    return consumer;
  },
};
