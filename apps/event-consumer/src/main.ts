import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

// Kafka consumers (analytics, audit-log, inventory-sync) are wired into
// AppModule when the Kafka infrastructure step is confirmed (see PLAN.md
// §3). This process currently only exposes a health endpoint.
async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  const port = process.env.EVENT_CONSUMER_PORT ?? 3002;
  await app.listen(port);
}

bootstrap();
