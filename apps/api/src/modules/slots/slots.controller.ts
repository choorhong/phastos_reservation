import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '@app/api/modules/auth/jwt-auth.guard';
import { Roles } from '@app/api/modules/auth/roles.decorator';
import { RolesGuard } from '@app/api/modules/auth/roles.guard';
import { ListSlotsDto } from './dto/list-slots.dto';
import { UpdateSlotDto } from './dto/update-slot.dto';
import { SlotAdminService } from './slot-admin.service';
import { SlotGeneratorService } from './slot-generator.service';

@Controller('slots')
@UseGuards(JwtAuthGuard)
export class SlotsController {
  constructor(
    private readonly slotAdmin: SlotAdminService,
    private readonly slotGenerator: SlotGeneratorService,
  ) {}

  /** Runs the generation sweep now instead of waiting for the next interval. */
  @Post('generate')
  @UseGuards(RolesGuard)
  @Roles('admin')
  async generate() {
    return { created: await this.slotGenerator.ensureWindow() };
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('admin')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSlotDto) {
    return this.slotAdmin.updateCapacity(id, dto.capacity);
  }

  @Get()
  findMany(@Query() query: ListSlotsDto) {
    return this.slotAdmin.findMany(query);
  }
}
