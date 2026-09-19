import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Logger } from 'nestjs-pino';
import { Repository } from 'typeorm';
import { AppConfigService } from '@lib/config';
import { Location, Slot } from '@lib/database';
import { assertValidSlotRule, buildSlotWindows, SlotRule } from './slot-schedule';

const GENERATION_INTERVAL_NAME = 'slot-generation-sweep';
// Well under Postgres' 65535 bind-parameter cap (4 columns per row).
const INSERT_CHUNK_SIZE = 500;

/**
 * Keeps every location stocked with slots for today plus the next
 * `SLOT_WINDOW_DAYS` days, following the one global rule in the env config
 * (weekdays only; hours are local to each location's timezone).
 *
 * The job is "make sure the whole window exists", not "create day N+30", so
 * downtime, restarts and newly created locations all self-heal on the next
 * run. It is idempotent -- `INSERT ... ON CONFLICT DO NOTHING` against the
 * unique `(location_id, start_time)` index -- which is also what makes it
 * safe when several api instances run it at once: existing rows, including
 * slots with reservations or a capacity an admin changed, are never touched.
 */
@Injectable()
export class SlotGeneratorService implements OnModuleInit, OnModuleDestroy {
  private readonly rule: SlotRule;
  private readonly capacity: number;
  private running = false;

  constructor(
    @InjectRepository(Slot) private readonly slots: Repository<Slot>,
    @InjectRepository(Location) private readonly locations: Repository<Location>,
    private readonly config: AppConfigService,
    private readonly scheduler: SchedulerRegistry,
    private readonly logger: Logger,
  ) {
    this.rule = {
      openHour: this.config.get('SLOT_OPEN_HOUR'),
      closeHour: this.config.get('SLOT_CLOSE_HOUR'),
      durationHours: this.config.get('SLOT_DURATION_HOURS'),
      windowDays: this.config.get('SLOT_WINDOW_DAYS'),
    };
    this.capacity = this.config.get('SLOT_CAPACITY');
    // Fail at boot on a rule that can't tile the day, not at the first run.
    assertValidSlotRule(this.rule);
    if (!Number.isInteger(this.capacity) || this.capacity < 1) {
      throw new Error('Invalid slot rule: SLOT_CAPACITY must be a positive integer');
    }
  }

  onModuleInit(): void {
    void this.runSweep();
    const handle = setInterval(
      () => void this.runSweep(),
      this.config.get('SLOT_GENERATION_INTERVAL_MS'),
    );
    this.scheduler.addInterval(GENERATION_INTERVAL_NAME, handle);
  }

  onModuleDestroy(): void {
    if (this.scheduler.doesExist('interval', GENERATION_INTERVAL_NAME)) {
      this.scheduler.deleteInterval(GENERATION_INTERVAL_NAME);
    }
  }

  /** Ensures the window for every location. Returns how many slots were newly created. */
  async ensureWindow(): Promise<number> {
    const locations = await this.locations.find();
    let created = 0;
    for (const location of locations) {
      try {
        created += await this.ensureWindowForLocation(location);
      } catch (err) {
        // One location with a bad timezone must not stop the others.
        this.logger.error({ err, locationId: location.id }, 'slot.generation.location_failed');
      }
    }
    return created;
  }

  async ensureWindowForLocation(location: Location, now: Date = new Date()): Promise<number> {
    const windows = buildSlotWindows(location.timezone, this.rule, now);
    let created = 0;
    for (let i = 0; i < windows.length; i += INSERT_CHUNK_SIZE) {
      const rows = windows.slice(i, i + INSERT_CHUNK_SIZE).map((window) => ({
        locationId: location.id,
        startTime: window.startTime,
        endTime: window.endTime,
        capacity: this.capacity,
      }));
      const result = await this.slots
        .createQueryBuilder()
        .insert()
        .into(Slot)
        .values(rows)
        .orIgnore()
        .returning('id')
        .execute();
      created += result.raw.length;
    }
    if (created > 0) {
      this.logger.log({ locationId: location.id, created }, 'slot.generation.created');
    }
    return created;
  }

  private async runSweep(): Promise<void> {
    if (this.running) {
      return; // a slow previous run is still going; don't stack another
    }
    this.running = true;
    try {
      await this.ensureWindow();
    } catch (err) {
      this.logger.error({ err }, 'slot.generation.sweep_failed');
    } finally {
      this.running = false;
    }
  }
}
