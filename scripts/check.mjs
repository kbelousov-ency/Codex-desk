// Single verification entry point: types, unit tests and renderer build.
// Runs steps sequentially and stops on the first failure. No model requests are made.
import { spawnSync } from 'node:child_process';

const steps = [
  { name: 'tsc --noEmit', args: ['node_modules/typescript/bin/tsc', '--noEmit'] },
  { name: 'node --test', args: ['--test', 'tests/*.test.mjs'] },
  { name: 'vite build', args: ['node_modules/vite/bin/vite.js', 'build'] },
];

const summary = [];
for (const step of steps) {
  const started = Date.now();
  process.stdout.write(`\n=== ${step.name} ===\n`);
  const result = spawnSync(process.execPath, step.args, { stdio: 'inherit' });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const ok = result.status === 0;
  summary.push({ step: step.name, ok, seconds });
  if (!ok) break;
}

process.stdout.write('\n=== Итог ===\n');
for (const row of summary) process.stdout.write(`${row.ok ? 'OK  ' : 'FAIL'} ${row.step} (${row.seconds}s)\n`);
if (summary.some(row => !row.ok)) process.exitCode = 1;
