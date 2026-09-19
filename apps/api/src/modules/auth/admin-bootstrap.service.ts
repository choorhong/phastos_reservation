import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Logger } from 'nestjs-pino';
import * as bcrypt from 'bcryptjs';
import { Repository } from 'typeorm';
import { AppConfigService } from '@lib/config';
import { User } from '@lib/database';

const BCRYPT_ROUNDS = 10;

/**
 * Self-registration (`AuthService.register`) can only ever create
 * `role: 'user'`, so the first admin account has to come from somewhere
 * else. This seeds one, idempotently, from `ADMIN_EMAIL`/`ADMIN_PASSWORD`
 * env vars on boot -- credentials live in `.env` (gitignored), never in a
 * migration or any committed file. A no-op if either var is unset, or if
 * a user with that email already exists (covers both "already bootstrapped"
 * and "don't clobber a real account that happens to share the email").
 */
@Injectable()
export class AdminBootstrapService implements OnModuleInit {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly config: AppConfigService,
    private readonly logger: Logger,
  ) {}

  async onModuleInit(): Promise<void> {
    const email = this.config.get('ADMIN_EMAIL');
    const password = this.config.get('ADMIN_PASSWORD');
    if (!email || !password) {
      return;
    }

    const existing = await this.users.findOne({ where: { email } });
    if (existing) {
      return;
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await this.users.save(this.users.create({ email, passwordHash, role: 'admin' }));
    this.logger.log({ email }, 'auth.admin_bootstrapped');
  }
}
