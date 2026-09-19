import { Global, Module } from '@nestjs/common';
import { JwtModule, JwtModuleOptions, JwtSignOptions } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfigModule, AppConfigService } from '@lib/config';
import { User } from '@lib/database';
import { AdminBootstrapService } from './admin-bootstrap.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';

/**
 * `@Global()` so `JwtAuthGuard`/`RolesGuard` resolve their own
 * dependencies (`JwtService`) correctly wherever `@UseGuards(...)`
 * references them by class, regardless of that controller's own module's
 * import graph -- same reasoning `@nestjs/typeorm` marks its core module
 * global internally.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([User]),
    JwtModule.registerAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): JwtModuleOptions => ({
        secret: config.get('JWT_SECRET'),
        signOptions: { expiresIn: config.get('JWT_EXPIRES_IN') as JwtSignOptions['expiresIn'] },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AdminBootstrapService, JwtAuthGuard, RolesGuard],
  // JwtModule re-exported too: JwtAuthGuard's own JwtService dependency
  // must resolve through the same global export, not just the guard class.
  exports: [JwtModule, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
