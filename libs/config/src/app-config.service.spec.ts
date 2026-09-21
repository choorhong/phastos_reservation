import { AppConfigService } from './app-config.service';
import { EnvKey, environmentSchema } from './environment-schema';

// The real module loads `.env` and validates it on import; the service only
// needs to read whatever that produced.
jest.mock('./environment-variables', () => ({
  environmentVariables: { POSTGRES_PORT: 5432, KAFKA_BROKERS: ['a:9092'], ADMIN_EMAIL: undefined },
}));

describe('AppConfigService', () => {
  const config = new AppConfigService();

  it('get returns the parsed value', () => {
    expect(config.get('POSTGRES_PORT')).toBe(5432);
    expect(config.get('KAFKA_BROKERS')).toEqual(['a:9092']);
  });

  it('get returns undefined for an optional variable that is unset', () => {
    expect(config.get('ADMIN_EMAIL')).toBeUndefined();
  });

  it('getOrThrow returns the value when it is set', () => {
    expect(config.getOrThrow('POSTGRES_PORT')).toBe(5432);
  });

  it('getOrThrow throws, naming the variable, when it is unset', () => {
    expect(() => config.getOrThrow('ADMIN_EMAIL')).toThrow(
      'Missing required environment variable: ADMIN_EMAIL',
    );
  });
});

describe('EnvKey', () => {
  it('has one entry per schema variable, each mapping to its own name', () => {
    expect(Object.keys(EnvKey).sort()).toEqual(Object.keys(environmentSchema).sort());
    for (const [key, value] of Object.entries(EnvKey)) {
      expect(value).toBe(key);
    }
  });
});
