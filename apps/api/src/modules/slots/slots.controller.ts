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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Slot } from '@lib/database';
import { JwtAuthGuard } from '@app/api/modules/auth/jwt-auth.guard';
import { Roles } from '@app/api/modules/auth/roles.decorator';
import { RolesGuard } from '@app/api/modules/auth/roles.guard';
import { GenerateSlotsResponseDto } from './dto/generate-slots-response.dto';
import { ListSlotsDto } from './dto/list-slots.dto';
import { UpdateSlotDto } from './dto/update-slot.dto';
import { SlotAdminService, SlotWithAvailability } from './slot-admin.service';
import { SlotGeneratorService } from './slot-generator.service';

@ApiTags('slots')
@ApiBearerAuth()
@Controller('slots')
@UseGuards(JwtAuthGuard)
export class SlotsController {
  constructor(
    private readonly slotAdmin: SlotAdminService,
    private readonly slotGenerator: SlotGeneratorService,
  ) {}

  /** Admin only. Runs the generation sweep now instead of waiting for the next interval. */
  @ApiOperation({ summary: 'Generate any missing slots for the rolling window now (admin only)' })
  @Post('generate')
  @UseGuards(RolesGuard)
  @Roles('admin')
  async generate(): Promise<GenerateSlotsResponseDto> {
    return { created: await this.slotGenerator.ensureWindow() };
  }

  /** Admin only. `capacity: 0` closes the slot (e.g. a holiday). */
  @ApiOperation({ summary: "Change a slot's capacity (admin only)" })
  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('admin')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSlotDto): Promise<Slot> {
    return this.slotAdmin.updateCapacity(id, dto.capacity);
  }

  @ApiOperation({ summary: 'List slots with their live availability' })
  @Get()
  findMany(@Query() query: ListSlotsDto): Promise<SlotWithAvailability[]> {
    return this.slotAdmin.findMany(query);
  }
}
