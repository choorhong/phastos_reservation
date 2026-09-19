import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppConfigService } from '@lib/config';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  configureApp(app);
  // Close the Kafka/RabbitMQ/Redis connections cleanly on SIGTERM/SIGINT.
  app.enableShutdownHooks();

  const port = app.get(AppConfigService).get('API_PORT');
  await app.listen(port);
}

bootstrap();
