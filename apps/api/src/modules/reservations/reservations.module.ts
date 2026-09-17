import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Reservation, Slot } from '@lib/database';
import { EventsModule } from '@app/api/modules/events/events.module';
import { NotificationsModule } from '@app/api/modules/notifications/notifications.module';
import { SlotsModule } from '@app/api/modules/slots/slots.module';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';

@Module({
  imports: [
    SlotsModule,
    EventsModule,
    NotificationsModule,
    TypeOrmModule.forFeature([Reservation, Slot]),
  ],
  controllers: [ReservationsController],
  providers: [ReservationsService],
})
export class ReservationsModule {}
