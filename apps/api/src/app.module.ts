import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ObservabilityModule } from '@lib/common';
import { DatabaseModule } from '@lib/database';
import { AuthModule } from './modules/auth/auth.module';
import { EventsModule } from './modules/events/events.module';
import { HealthController } from './modules/health/health.controller';
import { LocationsModule } from './modules/locations/locations.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ReservationsModule } from './modules/reservations/reservations.module';
import { SlotsModule } from './modules/slots/slots.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    ObservabilityModule,
    DatabaseModule,
    AuthModule,
    LocationsModule,
    SlotsModule,
    NotificationsModule,
    EventsModule,
    ReservationsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
