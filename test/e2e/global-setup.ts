import { execFileSync } from 'child_process';
import { resolve } from 'path';

/** Runs once before the e2e suites: see `setup-db.ts`. */
export default async function globalSetup(): Promise<void> {
  execFileSync(
    'npx',
    ['ts-node', '-r', 'tsconfig-paths/register', resolve(__dirname, 'setup-db.ts')],
    { stdio: 'inherit' },
  );
}
