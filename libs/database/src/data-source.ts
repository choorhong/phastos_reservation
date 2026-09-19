import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { environmentVariables } from '@lib/config';
import { Location, ProcessedEvent, Reservation, Slot, User } from './entities';

/**
 * Used by the TypeORM CLI (`npm run typeorm -- migration:run -d libs/database/src/data-source.ts`)
 * and mirrored (not shared directly, since Nest apps get their config via
 * AppConfigService) by `DatabaseModule.forRootAsync`. Both read the same
 * `environmentVariables`, so the same required-variable rules apply.
 */
export const AppDataSource = new DataSource({
  type: 'postgres',
  host: environmentVariables.POSTGRES_HOST,
  port: environmentVariables.POSTGRES_PORT,
  username: environmentVariables.POSTGRES_USER,
  password: environmentVariables.POSTGRES_PASSWORD,
  database: environmentVariables.POSTGRES_DB,
  entities: [Location, Slot, Reservation, ProcessedEvent, User],
  migrations: [__dirname + '/../migrations/*.{ts,js}'],
  synchronize: false,
});
