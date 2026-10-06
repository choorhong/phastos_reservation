import { execFileSync } from 'child_process';
import { resolve } from 'path';
import { assertNoDevAppsRunning } from './dev-apps-guard';

/** Runs once before the e2e suites: see `dev-apps-guard.ts` and `setup-db.ts`. */
export default async function globalSetup(): Promise<void> {
  await assertNoDevAppsRunning();
  execFileSync(
    'npx',
    ['ts-node', '-r', 'tsconfig-paths/register', resolve(__dirname, 'setup-db.ts')],
    { stdio: 'inherit' },
  );
}
