import { Controller, Get, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ObservabilityModule } from '@lib/common';
import { AppConfigModule } from '@lib/config';
import { DatabaseModule } from '@lib/database';
import { NotificationsModule } from './modules/notifications/notifications.module';

@Controller('health')
class HealthController {
  @Get()
  check() {
    return { status: 'ok', service: 'notification-worker', timestamp: new Date().toISOString() };
  }
}

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ObservabilityModule,
    AppConfigModule,
    DatabaseModule,
    NotificationsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
