import 'reflect-metadata';
import { config } from 'dotenv';
import { DataSource } from 'typeorm';
import { Location, ProcessedEvent, Reservation, Slot, User } from './entities';

config();

/**
 * Used by the TypeORM CLI (`npm run typeorm -- migration:run -d libs/database/src/data-source.ts`)
 * and mirrored (not shared directly, since Nest apps get their config via
 * ConfigService) by `DatabaseModule.forRootAsync` below.
 */
export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  username: process.env.POSTGRES_USER ?? 'phastos',
  password: process.env.POSTGRES_PASSWORD ?? 'phastos',
  database: process.env.POSTGRES_DB ?? 'phastos_reservation',
  entities: [Location, Slot, Reservation, ProcessedEvent, User],
  migrations: [__dirname + '/../migrations/*.{ts,js}'],
  synchronize: false,
});
