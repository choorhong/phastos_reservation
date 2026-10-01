import { environmentSchema } from './environment-schema';
import { loadEnvironment } from './load-environment';

/** A schema small enough to see every case; the real one has no boolean yet. */
const schema = {
  HOST: { type: 'string' },
  PORT: { type: 'number' },
  FLAG: { type: 'boolean' },
  BROKERS: { type: 'list' },
  NOTE: { type: 'string', optional: true },
} as const;

const valid = { HOST: 'localhost', PORT: '5432', FLAG: 'true', BROKERS: 'a:9092' };

/** Typed loosely: the return type of `loadEnvironment` describes the real schema, not this one. */
const load = (env: Record<string, string | undefined>) =>
  loadEnvironment(env, schema) as unknown as Record<string, unknown>;

describe('loadEnvironment', () => {
  describe('types', () => {
    it('parses each variable to its schema type', () => {
      expect(load({ ...valid, NOTE: 'hi' })).toEqual({
        HOST: 'localhost',
        PORT: 5432,
        FLAG: true,
        BROKERS: ['a:9092'],
        NOTE: 'hi',
      });
    });

    it('ignores variables that are not in the schema', () => {
      expect(load({ ...valid, UNRELATED: 'x' })).not.toHaveProperty('UNRELATED');
    });

    it('trims surrounding whitespace from every value', () => {
      expect(load({ ...valid, HOST: '  spaced  ', PORT: ' 5432 ' })).toMatchObject({
        HOST: 'spaced',
        PORT: 5432,
      });
    });
  });

  describe('number', () => {
    it.each([
      ['5432', 5432],
      ['0', 0],
      ['-1', -1],
      ['1.5', 1.5],
      ['1e3', 1000],
    ])('parses %j as %d', (raw, expected) => {
      expect(load({ ...valid, PORT: raw }).PORT).toBe(expected);
    });

    it.each(['abc', '12px', '1,000', 'NaN'])('rejects %j', (raw) => {
      expect(() => load({ ...valid, PORT: raw })).toThrow(
        `Invalid environment variable PORT: expected a number, got "${raw}"`,
      );
    });
  });

  describe('boolean', () => {
    it.each(['true', 'TRUE', 'True', '1', ' true '])('reads %j as true', (raw) => {
      expect(load({ ...valid, FLAG: raw }).FLAG).toBe(true);
    });

    it.each(['false', 'FALSE', 'False', '0', ' false '])('reads %j as false', (raw) => {
      expect(load({ ...valid, FLAG: raw }).FLAG).toBe(false);
    });

    it.each(['yes', 'no', 'on', 'off', '2', 'tru'])('rejects %j rather than guessing', (raw) => {
      expect(() => load({ ...valid, FLAG: raw })).toThrow(
        `Invalid environment variable FLAG: expected true/false or 1/0, got "${raw}"`,
      );
    });
  });

  describe('list', () => {
    it('splits on commas', () => {
      expect(load({ ...valid, BROKERS: 'a:9092,b:9092,c:9092' }).BROKERS).toEqual([
        'a:9092',
        'b:9092',
        'c:9092',
      ]);
    });

    it('trims each item', () => {
      expect(load({ ...valid, BROKERS: ' a:9092 ,  b:9092' }).BROKERS).toEqual([
        'a:9092',
        'b:9092',
      ]);
    });

    it('drops empty items from stray commas', () => {
      expect(load({ ...valid, BROKERS: ',a:9092,,b:9092,' }).BROKERS).toEqual(['a:9092', 'b:9092']);
    });

    it.each([',', ' , ,', '   '])('treats %j (no items) as missing', (raw) => {
      expect(() => load({ ...valid, BROKERS: raw })).toThrow(
        'Missing required environment variable(s): BROKERS',
      );
    });
  });

  describe('missing variables', () => {
    it('throws when a required variable is unset', () => {
      const { HOST: _omitted, ...env } = valid;
      expect(() => load(env)).toThrow('Missing required environment variable(s): HOST');
    });

    it.each(['', '   ', '\t\n'])('treats %j the same as unset', (raw) => {
      expect(() => load({ ...valid, HOST: raw })).toThrow(
        'Missing required environment variable(s): HOST',
      );
    });

    it('does not turn a whitespace-only number into 0', () => {
      expect(() => load({ ...valid, PORT: '  ' })).toThrow(
        'Missing required environment variable(s): PORT',
      );
    });

    it('lists every missing variable in a single error, in schema order', () => {
      expect(() => load({ FLAG: 'true' })).toThrow(
        'Missing required environment variable(s): HOST, PORT, BROKERS',
      );
    });

    it('throws for a malformed value before it reports missing ones', () => {
      expect(() => load({ PORT: 'abc' })).toThrow('Invalid environment variable PORT');
    });

    it('allows an optional variable to be unset or empty', () => {
      expect(load(valid).NOTE).toBeUndefined();
      expect(load({ ...valid, NOTE: '' }).NOTE).toBeUndefined();
      expect(load({ ...valid, NOTE: '  ' }).NOTE).toBeUndefined();
    });

    it('still parses an optional variable that is set', () => {
      expect(load({ ...valid, NOTE: 'x' }).NOTE).toBe('x');
    });
  });

  describe('against the real schema', () => {
    const everyVariable = Object.fromEntries(
      Object.entries(environmentSchema).map(([name, spec]) => [
        name,
        spec.type === 'number' ? '1' : 'x',
      ]),
    );

    it('accepts a fully populated environment', () => {
      expect(() => loadEnvironment(everyVariable)).not.toThrow();
    });

    it('requires everything except ADMIN_EMAIL, ADMIN_PASSWORD, EMAIL_REDIRECT_TO and NODE_ENV', () => {
      expect(() => loadEnvironment({})).toThrow(/Missing required environment variable\(s\)/);

      const optional = ['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'EMAIL_REDIRECT_TO', 'NODE_ENV'];
      const required = Object.keys(environmentSchema).filter((name) => !optional.includes(name));
      let message = '';
      try {
        loadEnvironment({});
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe(`Missing required environment variable(s): ${required.join(', ')}`);
    });

    it('needs no ADMIN_* variables (unset means "skip admin bootstrap")', () => {
      const { ADMIN_EMAIL: _e, ADMIN_PASSWORD: _p, ...withoutAdmin } = everyVariable;
      const loaded = loadEnvironment(withoutAdmin);
      expect(loaded.ADMIN_EMAIL).toBeUndefined();
      expect(loaded.ADMIN_PASSWORD).toBeUndefined();
    });
  });
});
