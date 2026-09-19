import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '@lib/domain';

export const ROLES_KEY = 'roles';

/** Combine with `JwtAuthGuard` + `RolesGuard` -- this alone doesn't authenticate. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
