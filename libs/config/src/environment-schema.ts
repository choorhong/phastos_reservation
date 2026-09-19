/**
 * Env vars are always strings; `type` is how that string is parsed:
 *  - `number`: `Number(raw)`, rejecting non-numeric values.
 *  - `boolean`: `true`/`false` or `1`/`0` (case-insensitive); anything
 *    else is rejected rather than guessed at.
 *  - `list`: comma-separated, items trimmed, empty items dropped
 *    (`'a:1, b:2'` -> `['a:1', 'b:2']`). A list with no items counts as missing.
 */
interface EnvironmentVariableSpec {
  type: 'string' | 'number' | 'boolean' | 'list';
  /** Only for variables that may legitimately be unset -- see below. */
  optional?: true;
}

/**
 * THE one place an env var is declared: its name, whether it is parsed as a
 * string or a number, and whether it may be absent. Everything else is
 * derived from this -- the `EnvironmentVariables` type, the `EnvKey` name
 * constants and the runtime parsing in `environment-variables.ts` -- so
 * adding a variable is one line here and nothing can drift out of sync.
 *
 * There are no defaults in any environment: every variable is required
 * (`environment-variables.ts` throws at boot if it isn't set) except:
 *  - `ADMIN_EMAIL`/`ADMIN_PASSWORD`: unset on purpose means "skip admin
 *    bootstrap" (see `AdminBootstrapService`), so they must NOT get a
 *    default value baked in.
 *  - `NODE_ENV`: whatever the host process sets it to, or unset.
 */
export const environmentSchema = {
  // Postgres
  POSTGRES_HOST: { type: 'string' },
  POSTGRES_PORT: { type: 'number' },
  POSTGRES_USER: { type: 'string' },
  POSTGRES_PASSWORD: { type: 'string' },
  POSTGRES_DB: { type: 'string' },

  // Redis
  REDIS_HOST: { type: 'string' },
  REDIS_PORT: { type: 'number' },
  HOLD_TTL_SECONDS: { type: 'number' },
  HOLD_REAPER_SWEEP_INTERVAL_MS: { type: 'number' },

  // RabbitMQ
  RABBITMQ_HOST: { type: 'string' },
  RABBITMQ_PORT: { type: 'number' },
  RABBITMQ_USER: { type: 'string' },
  RABBITMQ_PASSWORD: { type: 'string' },
  NOTIFICATION_MAX_RETRIES: { type: 'number' },

  // Reminder sweep (notification-worker)
  REMINDER_LEAD_MINUTES: { type: 'number' },
  REMINDER_SWEEP_INTERVAL_MS: { type: 'number' },

  // Kafka
  KAFKA_BROKERS: { type: 'list' },
  KAFKA_CLIENT_ID: { type: 'string' },
  KAFKA_TOPIC_REPLICATION_FACTOR: { type: 'number' },
  EVENT_CONSUMER_GROUP_ID: { type: 'string' },

  // Auth (apps/api/src/modules/auth)
  JWT_SECRET: { type: 'string' },
  JWT_EXPIRES_IN: { type: 'string' },
  ADMIN_EMAIL: { type: 'string', optional: true },
  ADMIN_PASSWORD: { type: 'string', optional: true },

  // apps
  API_PORT: { type: 'number' },
  NOTIFICATION_WORKER_PORT: { type: 'number' },
  EVENT_CONSUMER_PORT: { type: 'number' },

  NODE_ENV: { type: 'string', optional: true },
} as const satisfies Record<string, EnvironmentVariableSpec>;

type EnvironmentSchema = typeof environmentSchema;

type ValueTypeByName = {
  string: string;
  number: number;
  boolean: boolean;
  list: string[];
};

type ValueType<K extends keyof EnvironmentSchema> = ValueTypeByName[EnvironmentSchema[K]['type']];

type OptionalKey = {
  [K in keyof EnvironmentSchema]: EnvironmentSchema[K] extends { optional: true } ? K : never;
}[keyof EnvironmentSchema];

/** Every variable's name, e.g. `'POSTGRES_HOST' | 'POSTGRES_PORT' | ...`. */
export type EnvironmentVariableName = keyof EnvironmentSchema;

/**
 * Precisely typed values, derived from `environmentSchema`:
 * `AppConfigService.get('SOME_TYPO')` is a compile error instead of a
 * silent `undefined` at runtime, `get('POSTGRES_PORT')` is `number`, and
 * only the variables marked `optional` in the schema can be `undefined`.
 */
export type EnvironmentVariables = {
  [K in Exclude<EnvironmentVariableName, OptionalKey>]: ValueType<K>;
} & {
  [K in OptionalKey]?: ValueType<K>;
};

/**
 * Name constants, so code can say `EnvKey.POSTGRES_HOST` instead of
 * retyping `'POSTGRES_HOST'`. Built from the schema's own keys, so it can
 * never disagree with it.
 */
export const EnvKey = Object.fromEntries(
  Object.keys(environmentSchema).map((name) => [name, name]),
) as { readonly [K in EnvironmentVariableName]: K };
