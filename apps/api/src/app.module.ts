import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ObservabilityModule } from '@app/common';
import { DatabaseModule } from '@app/database';
import { EventsModule } from './modules/events/events.module';
import { HealthController } from './modules/health/health.controller';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { SlotsModule } from './modules/slots/slots.module';

// Domain modules (locations, reservations) and the actual HTTP
// reservations endpoints land here next -- see PLAN.md. All the
// infrastructure (Redis, Postgres, RabbitMQ, Kafka) they'll need is wired
// in below and ready.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    ObservabilityModule,
    DatabaseModule,
    SlotsModule,
    NotificationsModule,
    EventsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
