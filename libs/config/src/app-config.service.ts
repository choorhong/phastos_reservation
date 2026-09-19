import { Injectable } from '@nestjs/common';
import { environmentVariables } from './environment-variables';
import type { EnvironmentVariables } from './environment-variables.type';

/**
 * Same shape of API as `@nestjs/config`'s `ConfigService` (`get`/
 * `getOrThrow`), but keyed against `EnvironmentVariables` directly -- no
 * generic to remember at every injection site, and the return type is
 * always the real type of that key (e.g. `get('POSTGRES_PORT')` is
 * `number`), not `any`.
 */
@Injectable()
export class AppConfigService {
  get<K extends keyof EnvironmentVariables>(key: K): EnvironmentVariables[K] {
    return environmentVariables[key];
  }

  getOrThrow<K extends keyof EnvironmentVariables>(key: K): NonNullable<EnvironmentVariables[K]> {
    const value = environmentVariables[key];
    if (value === undefined || value === null) {
      throw new Error(`Missing required environment variable: ${String(key)}`);
    }
    return value as NonNullable<EnvironmentVariables[K]>;
  }
}
