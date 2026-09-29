import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfigModule, AppConfigService } from '@lib/config';
import { Location, ProcessedEvent, Reservation, Slot, User } from './entities';

/**
 * Postgres is the source of truth (docs/architecture.md §1/§5). `synchronize: false`
 * always -- schema changes go through migrations
 * (`npm run typeorm -- migration:run -d libs/database/src/data-source.ts`),
 * never auto-sync, so the `enforce_slot_capacity` trigger from the initial
 * migration is never silently dropped by a schema sync.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        type: 'postgres',
        host: config.get('POSTGRES_HOST'),
        port: config.get('POSTGRES_PORT'),
        username: config.get('POSTGRES_USER'),
        password: config.get('POSTGRES_PASSWORD'),
        database: config.get('POSTGRES_DB'),
        entities: [Location, Slot, Reservation, ProcessedEvent, User],
        synchronize: false,
      }),
    }),
    TypeOrmModule.forFeature([Location, Slot, Reservation, ProcessedEvent, User]),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
