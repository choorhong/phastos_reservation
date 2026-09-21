import { config as loadDotenv } from 'dotenv';
import { loadEnvironment } from './load-environment';
import type { EnvironmentVariables } from './environment-schema';

// Loaded here directly (not just via @nestjs/config's ConfigModule.forRoot())
// so this file is correct regardless of Nest's module-import order -- this
// module's top-level code can run before ConfigModule.forRoot() does (ES
// imports resolve before the importing file's own decorator/statements
// run). dotenv.config() is safe to call more than once.
loadDotenv();

/**
 * The single source of truth for every env var this app reads (declared in
 * `environment-schema.ts`), computed once at import time (fail-fast: a
 * missing/malformed value throws here, before the app accepts any request).
 * Values always come from `process.env` -- never hardcoded, and there are NO
 * defaults in any environment -- so production secrets can live entirely
 * outside this repo: a separate, devops-owned store/repo populates
 * `process.env` before the process starts in production, while local dev
 * keeps using the `.env` file via `loadDotenv()` above. This file doesn't
 * know or care which one it is.
 */
export const environmentVariables: EnvironmentVariables = loadEnvironment(process.env);
