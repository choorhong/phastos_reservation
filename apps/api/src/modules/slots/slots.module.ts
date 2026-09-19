import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Location, Reservation, Slot } from '@lib/database';
import { AuthModule } from '@app/api/modules/auth/auth.module';
import { EventsModule } from '@app/api/modules/events/events.module';
import { RedisModule } from '@app/api/modules/redis/redis.module';
import { HoldReaperService } from './hold-reaper.service';
import { SlotAdminService } from './slot-admin.service';
import { SlotGeneratorService } from './slot-generator.service';
import { SlotHoldService } from './slot-hold.service';
import { SlotsController } from './slots.controller';

@Module({
  imports: [
    AuthModule,
    EventsModule,
    RedisModule,
    TypeOrmModule.forFeature([Slot, Reservation, Location]),
  ],
  controllers: [SlotsController],
  providers: [SlotHoldService, HoldReaperService, SlotAdminService, SlotGeneratorService],
  exports: [SlotHoldService, SlotGeneratorService],
})
export class SlotsModule {}
