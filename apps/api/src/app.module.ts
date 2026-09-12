import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ObservabilityModule } from '@app/common';
import { DatabaseModule } from '@app/database';
import { HealthController } from './modules/health/health.controller';

// Domain modules (locations, slots, reservations) are added here as each
// remaining infrastructure step (Redis, Kafka, RabbitMQ) is wired in --
// see PLAN.md.
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ObservabilityModule, DatabaseModule],
  controllers: [HealthController],
})
export class AppModule {}
