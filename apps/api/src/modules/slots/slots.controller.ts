import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '@app/api/modules/auth/jwt-auth.guard';
import { Roles } from '@app/api/modules/auth/roles.decorator';
import { RolesGuard } from '@app/api/modules/auth/roles.guard';
import { CreateSlotDto } from './dto/create-slot.dto';
import { ListSlotsDto } from './dto/list-slots.dto';
import { SlotAdminService } from './slot-admin.service';

@Controller('slots')
@UseGuards(JwtAuthGuard)
export class SlotsController {
  constructor(private readonly slotAdmin: SlotAdminService) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles('admin')
  create(@Body() dto: CreateSlotDto) {
    return this.slotAdmin.create(dto);
  }

  @Get()
  findMany(@Query() query: ListSlotsDto) {
    return this.slotAdmin.findMany(query);
  }
}
