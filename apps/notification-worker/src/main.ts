import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

// RabbitMQ consumers (confirmation email, reminder, receipt generation) are
// wired into AppModule when the RabbitMQ infrastructure step is confirmed
// (see PLAN.md §4). This process currently only exposes a health endpoint.
async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  const port = process.env.NOTIFICATION_WORKER_PORT ?? 3001;
  await app.listen(port);
}

bootstrap();
