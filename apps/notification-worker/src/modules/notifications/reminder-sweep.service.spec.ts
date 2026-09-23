import { IsNull } from 'typeorm';
import { Reservation } from '@lib/database';
import { ReminderSweepService } from './reminder-sweep.service';

function reservation(id: string, overrides: Partial<Reservation> = {}): Reservation {
  return {
    id,
    userId: 'alice',
    slotId: 's1',
    reminderSentAt: null,
    correlationId: 'corr-1',
    slot: {
      startTime: new Date('2026-09-21T10:00:00Z'),
      location: { name: 'Orchard', timezone: 'Asia/Singapore' },
    },
    ...overrides,
  } as Reservation;
}

describe('ReminderSweepService', () => {
  const reservations = { find: jest.fn(), update: jest.fn() };
  const channel = { publish: jest.fn() };
  // REMINDER_LEAD_MINUTES read once in the constructor -- set before it runs, below.
  const config = { get: jest.fn().mockReturnValue(60) };
  const scheduler = { addInterval: jest.fn(), doesExist: jest.fn(), deleteInterval: jest.fn() };
  const logger = { log: jest.fn() };
  const service = new ReminderSweepService(
    reservations as never,
    channel as never,
    config as never,
    scheduler as never,
    logger as never,
  );

  // Private, but it's the sweep-and-claim logic under test -- onModuleInit only wires
  // it up to a setInterval, which adds nothing worth re-proving here.
  const sweep = () => (service as unknown as { sweep(): Promise<void> }).sweep();

  beforeEach(() => {
    jest.resetAllMocks();
    reservations.update.mockResolvedValue({ affected: 1 });
    channel.publish.mockResolvedValue(undefined);
  });

  it('queries confirmed reservations with no reminder sent yet, due within the lead window', async () => {
    reservations.find.mockResolvedValue([]);
    await sweep();

    const [[query]] = reservations.find.mock.calls;
    expect(query.where.status).toBe('confirmed');
    expect((query.where.reminderSentAt as { _type: string })._type).toBe('isNull');
    expect((query.where.slot.startTime as { _type: string })._type).toBe('between');
  });

  it('claims and publishes a reminder for a due reservation, then logs it', async () => {
    reservations.find.mockResolvedValue([reservation('r1')]);
    await sweep();

    expect(reservations.update).toHaveBeenCalledWith(
      { id: 'r1', reminderSentAt: IsNull() },
      { reminderSentAt: expect.any(Date) },
    );

    expect(channel.publish).toHaveBeenCalledTimes(1);
    const [, routingKey, content] = channel.publish.mock.calls[0];
    expect(routingKey).toBe('reminder');
    const envelope = JSON.parse((content as Buffer).toString('utf8'));
    expect(envelope.queue).toBe('reminder');
    expect(envelope.correlationId).toBe('corr-1');
    expect(envelope.payload).toMatchObject({
      reservationId: 'r1',
      userId: 'alice',
      locationName: 'Orchard',
      timezone: 'Asia/Singapore',
      slotStartTime: '2026-09-21T10:00:00.000Z',
    });

    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: 'r1', slotId: 's1', correlationId: 'corr-1' }),
      'reminder.sweep.enqueued',
    );
  });

  it('does not publish when the claim UPDATE affects no rows (already claimed by another tick/instance)', async () => {
    reservations.find.mockResolvedValue([reservation('r1')]);
    reservations.update.mockResolvedValue({ affected: 0 });

    await sweep();

    expect(channel.publish).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('generates a fresh correlationId when the reservation has none', async () => {
    reservations.find.mockResolvedValue([reservation('r1', { correlationId: undefined as never })]);
    await sweep();

    const [, , content] = channel.publish.mock.calls[0];
    const envelope = JSON.parse((content as Buffer).toString('utf8'));
    expect(typeof envelope.correlationId).toBe('string');
    expect(envelope.correlationId.length).toBeGreaterThan(0);
  });
});
