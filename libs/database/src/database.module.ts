import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Location, Reservation, Slot } from './entities';

/**
 * Postgres is the source of truth (PLAN.md §1/§5). `synchronize: false`
 * always -- schema changes go through migrations
 * (`npm run typeorm -- migration:run -d libs/database/src/data-source.ts`),
 * never auto-sync, so the `enforce_slot_capacity` trigger from the initial
 * migration is never silently dropped by a schema sync.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('POSTGRES_HOST', 'localhost'),
        port: config.get<number>('POSTGRES_PORT', 5432),
        username: config.get<string>('POSTGRES_USER', 'phastos'),
        password: config.get<string>('POSTGRES_PASSWORD', 'phastos'),
        database: config.get<string>('POSTGRES_DB', 'phastos_reservation'),
        entities: [Location, Slot, Reservation],
        synchronize: false,
      }),
    }),
    TypeOrmModule.forFeature([Location, Slot, Reservation]),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
