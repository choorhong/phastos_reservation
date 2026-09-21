import { environmentSchema } from './environment-schema';
import type { EnvironmentVariables } from './environment-schema';

type ParsedValue = string | number | boolean | string[];

interface VariableSpec {
  type: string;
  optional?: true;
}

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

/**
 * Walks `schema` over `env`, parsing each variable. Pure -- no dotenv, no
 * `process.env` -- so it can be exercised with any environment; the
 * import-time wrapper in `environment-variables.ts` feeds it the real one.
 * `schema` defaults to the real one and is only overridden by tests.
 */
export function loadEnvironment(
  env: NodeJS.ProcessEnv,
  schema: Record<string, VariableSpec> = environmentSchema,
): EnvironmentVariables {
  // Collected (rather than thrown one at a time) so a misconfigured
  // environment sees the full list in a single failure.
  const missing: string[] = [];
  const values: Record<string, ParsedValue | undefined> = {};

  for (const [name, spec] of Object.entries(schema)) {
    // Trimmed first, so a whitespace-only value counts as unset (otherwise
    // `Number('  ')` would quietly become 0).
    const raw = env[name]?.trim();
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
