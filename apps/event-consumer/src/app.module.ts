import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ObservabilityModule } from '@app/common';
import { DatabaseModule } from '@app/database';
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
    DatabaseModule,
    EventsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
