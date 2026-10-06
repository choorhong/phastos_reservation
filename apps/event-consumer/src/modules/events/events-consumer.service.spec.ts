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

describe('EventsConsumerService idempotent consumption and audit', () => {
  const query = jest.fn();
  // The claim and the audit insert run in one transaction; the mock just runs
  // the callback against the same `query`.
  const transaction = jest.fn((work: (m: { query: jest.Mock }) => unknown) => work({ query }));
  const processedEvents = { manager: { transaction } };
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

  beforeEach(() => {
    jest.clearAllMocks();
    query.mockReset();
  });

  it('claims a fresh event, then records it in reservation_audit, in one transaction', async () => {
    query.mockResolvedValueOnce([{ event_id: 'e1' }]).mockResolvedValueOnce([]);
    const event = kafkaEvent();

    await handleMessage(messagePayload(event));

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('ON CONFLICT DO NOTHING'), [
      'e1',
      'event-consumer',
    ]);
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO reservation_audit'),
      [
        'e1',
        'ReservationRequested',
        event.occurredAt,
        's1',
        'l1',
        'r1',
        'u1',
        'c1',
        JSON.stringify(event.payload),
      ],
    );
    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'e1', eventType: 'ReservationRequested', slotId: 's1' }),
      'reservation_event.processed',
    );
  });

  it('records a SlotReleased event with no reservation or user', async () => {
    query.mockResolvedValueOnce([{ event_id: 'e2' }]).mockResolvedValueOnce([]);
    const event = kafkaEvent({
      eventId: 'e2',
      eventType: 'SlotReleased',
      payload: { slotId: 's1', releasedCapacity: 1, reason: 'cancellation' },
    } as Partial<ReservationEvent>);

    await handleMessage(messagePayload(event));

    const [, auditParams] = query.mock.calls[1];
    expect(auditParams.slice(0, 2)).toEqual(['e2', 'SlotReleased']);
    expect(auditParams[5]).toBeNull(); // reservation_id
    expect(auditParams[6]).toBeNull(); // user_id
  });

  it('skips a redelivered event without reprocessing when the claim insert returns no row', async () => {
    query.mockResolvedValue([]); // ON CONFLICT DO NOTHING discarded the duplicate insert
    const event = kafkaEvent();

    await handleMessage(messagePayload(event));

    expect(query).toHaveBeenCalledTimes(1); // the claim only: no audit row for a duplicate

    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'e1', eventType: 'ReservationRequested' }),
      'reservation_event.duplicate_skipped',
    );
    expect(logger.log).not.toHaveBeenCalledWith(expect.anything(), 'reservation_event.processed');
  });

  it('ignores a message with no value', async () => {
    await handleMessage({ message: { value: null } } as unknown as EachMessagePayload);

    expect(transaction).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
  });
});
