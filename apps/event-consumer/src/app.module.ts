import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ObservabilityModule } from '@lib/common';
import { AppConfigModule } from '@lib/config';
import { DatabaseModule } from '@lib/database';
import { EventsModule } from './modules/events/events.module';

@Controller('health')
class HealthController {
  @Get()
  check() {
    return { status: 'ok', service: 'event-consumer', timestamp: new Date().toISOString() };
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ObservabilityModule,
    AppConfigModule,
    DatabaseModule,
    EventsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
