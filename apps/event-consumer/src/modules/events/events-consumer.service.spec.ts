import type { EachMessagePayload } from 'kafkajs';
import { ReservationEvent } from '@lib/kafka-contracts';
import { EventsConsumerService } from './events-consumer.service';

function kafkaEvent(overrides: Partial<ReservationEvent> = {}): ReservationEvent {
  return {
    eventId: 'e1',
    eventType: 'ReservationRequested',
    occurredAt: new Date().toISOString(),
    version: 1,
    slotId: 's1',
    locationId: 'l1',
    correlationId: 'c1',
    payload: {
      reservationId: 'r1',
      userId: 'u1',
      holdId: 'h1',
      requestedAt: new Date().toISOString(),
    },
    ...overrides,
  } as ReservationEvent;
}

function messagePayload(event: unknown): EachMessagePayload {
  return {
    topic: 'reservation-events',
    partition: 0,
    message: { value: Buffer.from(JSON.stringify(event), 'utf8') },
  } as unknown as EachMessagePayload;
}

describe('EventsConsumerService idempotent consumption', () => {
  const query = jest.fn();
  const processedEvents = { manager: { query } };
  const logger = { log: jest.fn() };
  const service = new EventsConsumerService(
    undefined as never,
    processedEvents as never,
    logger as never,
  );

  // Private, but it's the claim-then-process logic under test -- onModuleInit only wires
  // it up to the Kafka consumer's run(), which adds nothing worth re-proving here.
  const handleMessage = (payload: EachMessagePayload) =>
    (service as unknown as { handleMessage(p: EachMessagePayload): Promise<void> }).handleMessage(
      payload,
    );

  beforeEach(() => jest.resetAllMocks());

  it('claims a fresh event in processed_events before logging it as processed', async () => {
    query.mockResolvedValue([{ event_id: 'e1' }]);
    const event = kafkaEvent();

    await handleMessage(messagePayload(event));

    expect(query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT DO NOTHING'), [
      'e1',
      'event-consumer',
    ]);
    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'e1', eventType: 'ReservationRequested', slotId: 's1' }),
      'reservation_event.processed',
    );
  });

  it('skips a redelivered event without reprocessing when the claim insert returns no row', async () => {
    query.mockResolvedValue([]); // ON CONFLICT DO NOTHING discarded the duplicate insert
    const event = kafkaEvent();

    await handleMessage(messagePayload(event));

    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'e1', eventType: 'ReservationRequested' }),
      'reservation_event.duplicate_skipped',
    );
    expect(logger.log).not.toHaveBeenCalledWith(expect.anything(), 'reservation_event.processed');
  });

  it('ignores a message with no value', async () => {
    await handleMessage({ message: { value: null } } as unknown as EachMessagePayload);

    expect(query).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
  });
});
