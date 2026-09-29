import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
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

  // /docs is unauthenticated, same as every GET endpoint it describes -- see
  // docs/progress.md's rate-limiting/auth backlog notes if that ever needs to
  // change. Not wired into `app.setup.ts`/the e2e suite: it's static
  // documentation, not request handling, so there's nothing there worth
  // testing on every jest boot.
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Phastos Reservation API')
      .setDescription(
        'Appointment booking: locations, generated slots, and the reservation ' +
          'hold/confirm/cancel lifecycle. Every route except /health, ' +
          '/auth/register and /auth/login requires a bearer JWT from /auth/login.',
      )
      .setVersion('1.0')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('docs', app, document);

  const port = app.get(AppConfigService).get('API_PORT');
  await app.listen(port);
}

bootstrap();
