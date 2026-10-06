import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReservationAudit } from '@lib/database';
import { AuthModule } from '@app/api/modules/auth/auth.module';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([ReservationAudit])],
  controllers: [AuditController],
  providers: [AuditService],
})
export class AuditModule {}
