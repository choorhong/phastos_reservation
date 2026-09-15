import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Reservation } from '@app/database';
import { RabbitmqModule } from '../rabbitmq/rabbitmq.module';
import { NotificationConsumersService } from './notification-consumers.service';
import { ReminderSweepService } from './reminder-sweep.service';

@Module({
  imports: [RabbitmqModule, TypeOrmModule.forFeature([Reservation])],
  providers: [NotificationConsumersService, ReminderSweepService],
})
export class NotificationsModule {}
