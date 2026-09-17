import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Consumer, Kafka } from 'kafkajs';
import { ensureReservationEventsTopic, RESERVATION_EVENTS_TOPIC } from '@lib/kafka-contracts';

export const KAFKA_CONSUMER = Symbol('KAFKA_CONSUMER');

export const kafkaConsumerProvider: Provider = {
  provide: KAFKA_CONSUMER,
  inject: [ConfigService],
  useFactory: async (config: ConfigService): Promise<Consumer> => {
    const kafka = new Kafka({
      clientId: config.get<string>('KAFKA_CLIENT_ID', 'phastos-reservation'),
      brokers: config.get<string>('KAFKA_BROKERS', 'localhost:9092').split(','),
    });

    const admin = kafka.admin();
    await admin.connect();
    await ensureReservationEventsTopic(
      admin,
      config.get<number>('KAFKA_TOPIC_REPLICATION_FACTOR', 1),
    );
    await admin.disconnect();

    const consumer = kafka.consumer({
      groupId: config.get<string>('EVENT_CONSUMER_GROUP_ID', 'event-consumer'),
    });
    await consumer.connect();
    await consumer.subscribe({ topic: RESERVATION_EVENTS_TOPIC, fromBeginning: false });
    return consumer;
  },
};
