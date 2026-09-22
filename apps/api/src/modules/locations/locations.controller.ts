import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Location } from '@lib/database';
import { JwtAuthGuard } from '@app/api/modules/auth/jwt-auth.guard';
import { Roles } from '@app/api/modules/auth/roles.decorator';
import { RolesGuard } from '@app/api/modules/auth/roles.guard';
import { CreateLocationDto } from './dto/create-location.dto';
import { UpdateLocationDto } from './dto/update-location.dto';
import { LocationsService } from './locations.service';

@ApiTags('locations')
@ApiBearerAuth()
@Controller('locations')
@UseGuards(JwtAuthGuard)
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  /** Admin only. Slots for the new location are generated immediately (see `SlotGeneratorService`). */
  @ApiOperation({ summary: 'Create a location (admin only)' })
  @Post()
  @UseGuards(RolesGuard)
  @Roles('admin')
  create(@Body() dto: CreateLocationDto): Promise<Location> {
    return this.locations.create(dto);
  }

  /** Admin only. Only `name`/`address` are editable -- see `UpdateLocationDto`. */
  @ApiOperation({ summary: "Edit a location's name and/or address (admin only)" })
  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('admin')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateLocationDto): Promise<Location> {
    return this.locations.update(id, dto);
  }

  @ApiOperation({ summary: 'List every location' })
  @Get()
  findAll(): Promise<Location[]> {
    return this.locations.findAll();
  }
}
