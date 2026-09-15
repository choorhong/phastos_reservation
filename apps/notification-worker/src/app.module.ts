import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ObservabilityModule } from '@app/common';
import { DatabaseModule } from '@app/database';
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
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    ObservabilityModule,
    DatabaseModule,
    NotificationsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
