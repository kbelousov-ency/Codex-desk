// Runs the host scenarios that use real Electron and installed CLIs without model requests.
// Each scenario is a separate process; failures are collected and reported at the end.
// Usage: node scripts/hosts.mjs [name ...]   (names without the "ui-" prefix and "-host" suffix)
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const all = readdirSync('scripts')
  .filter(name => /^ui-.*-host\.mjs$/.test(name))
  .map(name => name.replace(/^ui-/, '').replace(/-host\.mjs$/, ''))
  .sort();
const requested = process.argv.slice(2);
const unknown = requested.filter(name => !all.includes(name));
if (unknown.length) {
  console.error(`Неизвестные сценарии: ${unknown.join(', ')}\nДоступны: ${all.join(', ')}`);
  process.exit(2);
}
const selected = requested.length ? requested : all;

const results = [];
for (const name of selected) {
  const script = `scripts/ui-${name}-host.mjs`;
  const started = Date.now();
  process.stdout.write(`\n=== ${script} ===\n`);
  const result = spawnSync(process.execPath, [script], { stdio: 'inherit' });
  results.push({ name, ok: result.status === 0, seconds: ((Date.now() - started) / 1000).toFixed(1) });
}

process.stdout.write('\n=== Итог host-сценариев ===\n');
for (const row of results) process.stdout.write(`${row.ok ? 'OK  ' : 'FAIL'} ${row.name} (${row.seconds}s)\n`);
if (results.some(row => !row.ok)) process.exitCode = 1;
