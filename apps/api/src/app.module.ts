import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ObservabilityModule } from '@app/common';
import { HealthController } from './modules/health/health.controller';

// Domain modules (locations, slots, reservations) are added here as each
// infrastructure step (Postgres, Redis, Kafka, RabbitMQ) is wired in --
// see PLAN.md. Kept minimal for now so the app boots on its own.
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ObservabilityModule],
  controllers: [HealthController],
})
export class AppModule {}
