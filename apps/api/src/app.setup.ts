import { INestApplication, ValidationPipe } from '@nestjs/common';

/**
 * App-level setup shared by `main.ts` and the e2e tests, so the tests run
 * against exactly the request handling production has.
 */
export function configureApp(app: INestApplication): void {
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
}
