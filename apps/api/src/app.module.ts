import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ObservabilityModule } from '@app/common';
import { DatabaseModule } from '@app/database';
import { HealthController } from './modules/health/health.controller';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { SlotsModule } from './modules/slots/slots.module';

// Domain modules (locations, reservations) are added here as each
// remaining infrastructure step (Kafka) is wired in, and the HTTP
// reservations endpoints land -- see PLAN.md.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    ObservabilityModule,
    DatabaseModule,
    SlotsModule,
    NotificationsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
