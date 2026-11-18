import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT } from '../core/paths.mjs';

const temporary = await mkdtemp(path.join(tmpdir(), 'ontology-unit-tests-'));
try {
  const tests = (await readdir(path.join(ROOT, 'tests'))).filter(f => f.endsWith('.test.mjs')).sort();
  const result = spawnSync(process.execPath, ['--test', ...tests.map(f => path.join(ROOT, 'tests', f))], {
    cwd: ROOT, stdio: 'inherit',
    env: { ...process.env, STUDIO_DATA_DIR: temporary, STUDIO_HOST: '127.0.0.1', STUDIO_OPEN: '' }
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}

