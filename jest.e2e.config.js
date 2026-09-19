const { pathsToModuleNameMapper } = require('ts-jest');
const { compilerOptions } = require('./tsconfig.json');

/**
 * End-to-end tests: boot the real api (`AppModule`) against the
 * docker-compose Postgres/Redis/RabbitMQ/Kafka and drive it over HTTP.
 * `npm run test:e2e`. Not picked up by the unit-test config (`npm test`).
 */
module.exports = {
  testEnvironment: 'node',
  // @nestjs/jwt 12 ships ES modules only (the webpack build copes; jest runs
  // CommonJS), so that one package is transpiled too -- hence allowJs.
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/test/tsconfig.json' }],
  },
  transformIgnorePatterns: ['/node_modules/(?!@nestjs/jwt/)'],
  roots: ['<rootDir>/test'],
  testRegex: '.*\\.e2e-spec\\.ts$',
  moduleNameMapper: pathsToModuleNameMapper(compilerOptions.paths, { prefix: '<rootDir>/' }),
  globalSetup: '<rootDir>/test/e2e/global-setup.ts',
  setupFiles: ['<rootDir>/test/e2e/env.ts'],
  testTimeout: 30000,
};
