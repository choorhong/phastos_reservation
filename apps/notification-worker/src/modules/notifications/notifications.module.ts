import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Reservation, User } from '@lib/database';
import { EmailModule } from '@app/notification-worker/modules/email/email.module';
import { RabbitmqModule } from '@app/notification-worker/modules/rabbitmq/rabbitmq.module';
import { NotificationConsumersService } from './notification-consumers.service';
import { NotificationSenderService } from './notification-sender.service';
import { ReminderSweepService } from './reminder-sweep.service';

@Module({
  imports: [EmailModule, RabbitmqModule, TypeOrmModule.forFeature([Reservation, User])],
  providers: [NotificationConsumersService, NotificationSenderService, ReminderSweepService],
})
export class NotificationsModule {}
