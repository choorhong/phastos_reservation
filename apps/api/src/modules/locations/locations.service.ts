import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Location } from '@lib/database';
import { CreateLocationDto } from './dto/create-location.dto';

@Injectable()
export class LocationsService {
  constructor(@InjectRepository(Location) private readonly locations: Repository<Location>) {}

  create(dto: CreateLocationDto): Promise<Location> {
    return this.locations.save(this.locations.create(dto));
  }

  findAll(): Promise<Location[]> {
    return this.locations.find({ order: { name: 'ASC' } });
  }
}
