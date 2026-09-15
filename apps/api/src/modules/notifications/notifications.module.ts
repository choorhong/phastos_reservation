import { Module } from '@nestjs/common';
import { RabbitmqModule } from '@/modules/rabbitmq/rabbitmq.module';
import { NotificationsPublisherService } from './notifications-publisher.service';

@Module({
  imports: [RabbitmqModule],
  providers: [NotificationsPublisherService],
  exports: [NotificationsPublisherService],
})
export class NotificationsModule {}
