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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser } from '@app/api/modules/auth/auth.types';
import { CurrentUser } from '@app/api/modules/auth/current-user.decorator';
import { JwtAuthGuard } from '@app/api/modules/auth/jwt-auth.guard';
import { CancelReservationDto } from './dto/cancel-reservation.dto';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { ListReservationsDto } from './dto/list-reservations.dto';
import { ReservationsService } from './reservations.service';
import { ReservationView } from './reservation-view';

@ApiTags('reservations')
@ApiBearerAuth()
@Controller('reservations')
@UseGuards(JwtAuthGuard)
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  /** Books the caller (from the JWT, never a client-supplied `userId`) onto a slot. Status starts as `held`. */
  @ApiOperation({ summary: 'Request a hold on a slot' })
  @Post()
  create(
    @Body() dto: CreateReservationDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReservationView> {
    return this.reservations.requestHold(dto, user.userId);
  }

  /** The caller's own bookings (also for admins -- it is "my bookings", not "all bookings"). */
  @ApiOperation({ summary: "List the caller's own reservations" })
  @Get()
  findMine(
    @Query() query: ListReservationsDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReservationView[]> {
    return this.reservations.listForUser(user.userId, query);
  }

  /** Owner or admin only. */
  @ApiOperation({ summary: 'Get one reservation' })
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReservationView> {
    return this.reservations.findOne(id, user);
  }

  /** Owner or admin only. Idempotent if already `confirmed`; 410 if the hold expired first. */
  @ApiOperation({ summary: 'Confirm a held reservation' })
  @Post(':id/confirm')
  @HttpCode(200)
  confirm(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReservationView> {
    return this.reservations.confirm(id, user);
  }

  /** Owner or admin only. Works for both a `held` and a `confirmed` reservation. */
  @ApiOperation({ summary: 'Cancel a reservation' })
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelReservationDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReservationView> {
    return this.reservations.cancel(id, dto, user);
  }
}
