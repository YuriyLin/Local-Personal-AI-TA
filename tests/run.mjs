import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(testsDir, '../node_modules/tsx/dist/cli.mjs');
const listTests = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const name = path.join(dir, entry.name);
  return entry.isDirectory() ? listTests(name) : entry.isFile() && entry.name.endsWith('.test.ts') ? [name] : [];
});
const tests = listTests(testsDir);
if (!tests.length) throw new Error('No test files found.');

const tempRoot = fs.realpathSync(os.tmpdir());
const sandbox = fs.mkdtempSync(path.join(tempRoot, 'biibo-suite-'));
try {
  const result = spawnSync(process.execPath, [cli, '--test', ...tests], {
    cwd: sandbox, stdio: 'inherit', env: { ...process.env, BIIBO_SUITE_ROOT: sandbox },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  const resolved = fs.realpathSync(sandbox);
  if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith('biibo-suite-')) {
    throw new Error('Refusing to remove an unexpected test directory.');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}
