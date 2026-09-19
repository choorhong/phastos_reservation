import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedUser } from '@app/api/modules/auth/auth.types';
import { CurrentUser } from '@app/api/modules/auth/current-user.decorator';
import { JwtAuthGuard } from '@app/api/modules/auth/jwt-auth.guard';
import { CancelReservationDto } from './dto/cancel-reservation.dto';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { ListReservationsDto } from './dto/list-reservations.dto';
import { ReservationsService } from './reservations.service';

@Controller('reservations')
@UseGuards(JwtAuthGuard)
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  @Post()
  create(@Body() dto: CreateReservationDto, @CurrentUser() user: AuthenticatedUser) {
    return this.reservations.requestHold(dto, user.userId);
  }

  /** The caller's own bookings (also for admins -- it is "my bookings", not "all bookings"). */
  @Get()
  findMine(@Query() query: ListReservationsDto, @CurrentUser() user: AuthenticatedUser) {
    return this.reservations.listForUser(user.userId, query);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.reservations.findOne(id, user);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  confirm(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.reservations.confirm(id, user);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelReservationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reservations.cancel(id, dto, user);
  }
}
