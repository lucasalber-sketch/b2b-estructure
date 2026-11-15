// Atalho multiplataforma para `LIVE=1 npm test` (no PowerShell, `LIVE=1 ...` não funciona).
import { spawnSync } from 'node:child_process';

const r = spawnSync(process.execPath, ['--test', 'test/live/*.test.js'], {
  stdio: 'inherit',
  env: { ...process.env, LIVE: '1' },
});
process.exit(r.status ?? 1);
