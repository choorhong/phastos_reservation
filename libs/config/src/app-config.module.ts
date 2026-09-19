import { Global, Module } from '@nestjs/common';
import { AppConfigService } from './app-config.service';

/**
 * `@Global()` so `AppConfigService` is injectable anywhere in an app that
 * imports this module once (its own root `AppModule`), the same way
 * `@nestjs/config`'s `ConfigService` is global when `ConfigModule.forRoot`
 * is passed `isGlobal: true`.
 */
@Global()
@Module({
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
