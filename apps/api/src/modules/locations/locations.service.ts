import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Logger } from 'nestjs-pino';
import { Repository } from 'typeorm';
import { Location } from '@lib/database';
import { SlotGeneratorService } from '@app/api/modules/slots/slot-generator.service';
import { CreateLocationDto } from './dto/create-location.dto';

@Injectable()
export class LocationsService {
  constructor(
    @InjectRepository(Location) private readonly locations: Repository<Location>,
    private readonly slotGenerator: SlotGeneratorService,
    private readonly logger: Logger,
  ) {}

  /**
   * Stocks the new location with slots straight away rather than waiting for
   * the next generation sweep. A failure here doesn't fail the request: the
   * location is saved and the sweep will fill it in.
   */
  async create(dto: CreateLocationDto): Promise<Location> {
    const location = await this.locations.save(this.locations.create(dto));
    try {
      await this.slotGenerator.ensureWindowForLocation(location);
    } catch (err) {
      this.logger.error({ err, locationId: location.id }, 'slot.generation.location_failed');
    }
    return location;
  }

  findAll(): Promise<Location[]> {
    return this.locations.find({ order: { name: 'ASC' } });
  }
}
