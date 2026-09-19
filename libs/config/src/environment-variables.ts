import { config as loadDotenv } from 'dotenv';
import { environmentSchema } from './environment-schema';
import type { EnvironmentVariableName, EnvironmentVariables } from './environment-schema';

// Loaded here directly (not just via @nestjs/config's ConfigModule.forRoot())
// so this file is correct regardless of Nest's module-import order -- this
// module's top-level code can run before ConfigModule.forRoot() does (ES
// imports resolve before the importing file's own decorator/statements
// run). dotenv.config() is safe to call more than once.
loadDotenv();

type ParsedValue = string | number | boolean | string[];

const TRUE_VALUES = ['true', '1'];
const FALSE_VALUES = ['false', '0'];

/**
 * Turns a set (non-empty) raw string into its schema type. Throws for a
 * malformed value; returns `undefined` only for a list with no items, which
 * the caller treats the same as an unset variable.
 */
function parse(name: string, type: string, raw: string): ParsedValue | undefined {
  switch (type) {
    case 'number': {
      const value = Number(raw);
      if (Number.isNaN(value)) {
        throw new Error(`Invalid environment variable ${name}: expected a number, got "${raw}"`);
      }
      return value;
    }
    case 'boolean': {
      const normalised = raw.trim().toLowerCase();
      if (TRUE_VALUES.includes(normalised)) {
        return true;
      }
      if (FALSE_VALUES.includes(normalised)) {
        return false;
      }
      throw new Error(
        `Invalid environment variable ${name}: expected true/false or 1/0, got "${raw}"`,
      );
    }
    case 'list': {
      const items = raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      return items.length > 0 ? items : undefined;
    }
    default:
      return raw;
  }
}

function load(): EnvironmentVariables {
  // Collected (rather than thrown one at a time) so a misconfigured
  // environment sees the full list in a single failure.
  const missing: string[] = [];
  const values: Record<string, ParsedValue | undefined> = {};

  for (const name of Object.keys(environmentSchema) as EnvironmentVariableName[]) {
    const spec: { type: string; optional?: true } = environmentSchema[name];
    const raw = process.env[name];
    const value = raw === undefined || raw === '' ? undefined : parse(name, spec.type, raw);

    if (value === undefined && !spec.optional) {
      missing.push(name);
    }
    values[name] = value;
  }

  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }
  return values as EnvironmentVariables;
}

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
export const environmentVariables: EnvironmentVariables = load();
