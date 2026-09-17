import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Reservation, Slot } from '@lib/database';
import { RedisModule } from '@app/api/modules/redis/redis.module';
import { HoldReaperService } from './hold-reaper.service';
import { SlotHoldService } from './slot-hold.service';

@Module({
  imports: [RedisModule, TypeOrmModule.forFeature([Slot, Reservation])],
  providers: [SlotHoldService, HoldReaperService],
  exports: [SlotHoldService],
})
export class SlotsModule {}
