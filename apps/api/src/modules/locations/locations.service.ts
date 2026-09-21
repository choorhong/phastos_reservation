import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Logger } from 'nestjs-pino';
import { Repository } from 'typeorm';
import { Location } from '@lib/database';
import { SlotGeneratorService } from '@app/api/modules/slots/slot-generator.service';
import { CreateLocationDto } from './dto/create-location.dto';
import { UpdateLocationDto } from './dto/update-location.dto';

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

  /** Edits the name and/or address. An empty body changes nothing and returns the location as it is. */
  async update(id: string, dto: UpdateLocationDto): Promise<Location> {
    const location = await this.locations.findOne({ where: { id } });
    if (!location) {
      throw new NotFoundException(`Location ${id} not found`);
    }
    if (dto.name === undefined && dto.address === undefined) {
      return location;
    }
    if (dto.name !== undefined) {
      location.name = dto.name;
    }
    if (dto.address !== undefined) {
      location.address = dto.address;
    }
    return this.locations.save(location);
  }

  findAll(): Promise<Location[]> {
    return this.locations.find({ order: { name: 'ASC' } });
  }
}
