import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { ACTIVE_RESERVATION_UNIQUE_INDEX, Location, Reservation, Slot } from '@lib/database';
import { AuthenticatedUser } from '@app/api/modules/auth/auth.types';
import { ReservationsService } from './reservations.service';

function reservation(id: string, userId: string): Reservation {
  return {
    id,
    userId,
    slotId: 's1',
    status: 'confirmed',
    createdAt: new Date(),
    slot: {
      id: 's1',
      startTime: new Date('2026-09-21T02:00:00Z'),
      endTime: new Date('2026-09-21T04:00:00Z'),
      location: { id: 'l1', name: 'Orchard', address: 'x', timezone: 'Asia/Singapore' } as Location,
    } as Slot,
  } as Reservation;
}

describe('ReservationsService reads', () => {
  const alice: AuthenticatedUser = { userId: 'alice', role: 'user' };
  const bob: AuthenticatedUser = { userId: 'bob', role: 'user' };
  const admin: AuthenticatedUser = { userId: 'admin', role: 'admin' };

  const repo = { findOne: jest.fn(), find: jest.fn() };
  // Only the reservations repository is touched by the read paths.
  const service = new ReservationsService(
    repo as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
  );

  beforeEach(() => jest.resetAllMocks());

  describe('findOne', () => {
    it('returns the owner their reservation with local times', async () => {
      repo.findOne.mockResolvedValue(reservation('r1', 'alice'));
      const view = await service.findOne('r1', alice);
      expect(view.id).toBe('r1');
      expect(view.slot.localStartTime).toBe('10:00');
    });

    it('lets an admin read anyone’s reservation', async () => {
      repo.findOne.mockResolvedValue(reservation('r1', 'alice'));
      await expect(service.findOne('r1', admin)).resolves.toMatchObject({ id: 'r1' });
    });

    it('refuses another user', async () => {
      repo.findOne.mockResolvedValue(reservation('r1', 'alice'));
      await expect(service.findOne('r1', bob)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404s an unknown id', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.findOne('nope', alice)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listForUser', () => {
    it('only ever queries the caller’s own reservations, soonest slot first', async () => {
      repo.find.mockResolvedValue([reservation('r1', 'alice')]);
      const views = await service.listForUser('alice', {});
      expect(views).toHaveLength(1);
      expect(repo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'alice' },
          order: { slot: { startTime: 'ASC' } },
        }),
      );
    });

    it('adds the status filter when given, without dropping the user filter', async () => {
      repo.find.mockResolvedValue([]);
      await service.listForUser('alice', { status: 'confirmed' });
      expect(repo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'alice', status: 'confirmed' } }),
      );
    });
  });
});

describe('ReservationsService.requestHold, one spot per person per slot', () => {
  const slot = { id: 's1', locationId: 'l1', location: { name: 'Orchard' } } as Slot;

  const reservations = { exists: jest.fn(), create: jest.fn(), save: jest.fn() };
  const slots = { findOne: jest.fn() };
  const holds = { claim: jest.fn(), release: jest.fn() };
  const service = new ReservationsService(
    reservations as never,
    slots as never,
    holds as never,
    { publishReservationRequested: jest.fn() } as never,
    undefined as never,
    { getId: () => 'corr-1' } as never,
    { warn: jest.fn() } as never,
  );

  const uniqueViolation = (constraint: string) =>
    new QueryFailedError(
      'INSERT',
      [],
      Object.assign(new Error('duplicate'), { code: '23505', constraint }),
    );

  beforeEach(() => {
    jest.resetAllMocks();
    slots.findOne.mockResolvedValue(slot);
    reservations.exists.mockResolvedValue(false);
    holds.claim.mockResolvedValue({ holdId: 'h1' });
    reservations.create.mockImplementation((r) => r);
  });

  it('refuses a user who already holds or has confirmed the slot, before touching Redis', async () => {
    reservations.exists.mockResolvedValue(true);

    await expect(service.requestHold({ slotId: 's1' }, 'alice')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(holds.claim).not.toHaveBeenCalled();
  });

  it('gives the Redis spot back when a concurrent request wins the unique index', async () => {
    reservations.save.mockRejectedValue(uniqueViolation(ACTIVE_RESERVATION_UNIQUE_INDEX));

    await expect(service.requestHold({ slotId: 's1' }, 'alice')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(holds.release).toHaveBeenCalledWith('s1', 'h1');
  });

  it('does not treat some other unique violation (e.g. the holdId) as a duplicate booking', async () => {
    const err = uniqueViolation('reservations_hold_id_key');
    reservations.save.mockRejectedValue(err);

    await expect(service.requestHold({ slotId: 's1' }, 'alice')).rejects.toBe(err);
    expect(holds.release).not.toHaveBeenCalled();
  });
});
