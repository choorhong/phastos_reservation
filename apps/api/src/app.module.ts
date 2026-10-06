import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ObservabilityModule } from '@lib/common';
import { AppConfigModule } from '@lib/config';
import { DatabaseModule } from '@lib/database';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { EventsModule } from './modules/events/events.module';
import { HealthController } from './modules/health/health.controller';
import { LocationsModule } from './modules/locations/locations.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ReservationsModule } from './modules/reservations/reservations.module';
import { SlotsModule } from './modules/slots/slots.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ObservabilityModule,
    AppConfigModule,
    DatabaseModule,
    AuthModule,
    LocationsModule,
    SlotsModule,
    NotificationsModule,
    EventsModule,
    ReservationsModule,
    AuditModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
