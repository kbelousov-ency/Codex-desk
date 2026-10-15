import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

// Рубильник телефонного пульта по каналу сборки (решение владельца 2026-10-15):
// stable — пульта нет совсем, nightly/experimental3/development — есть.
// Настоящие main, preload и renderer; канал подменяется только тестовой переменной,
// ровно как при promotion меняется маркер канала — без пересборки.
const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });

async function boot(channel) {
  const run = await mkdtemp(path.join(root, 'artifacts', `phone-pult-${channel ?? 'dev'}-`));
  const project = path.join(run, 'PROJECT'), profile = path.join(run, 'profile');
  await Promise.all([mkdir(project), mkdir(profile)]);
  await writeFile(path.join(project, 'package.json'), '{"type":"module"}');
  // Агент не нужен: проверяется поставка пульта, а не беседа. CLI остаётся «не найден».
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ cwd: project, model: 'fixture', effort: 'high', access: 'auto' }));
  const env = { ...process.env, CODEX_DESK_DATA_DIR: profile, CODEX_DESK_TEST: '1' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.CODEX_DESK_DEV_URL; delete env.CODEX_DESK_TEST_CHANNEL;
  if (channel) env.CODEX_DESK_TEST_CHANNEL = channel;
  const app = await electron.launch({ args: ['.'], cwd: root, env, timeout: 30000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  return { app, page, profile };
}

const until = async (test, label) => { const end = Date.now() + 20000; while (!await test()) { assert.ok(Date.now() < end, label); await delay(60); } };

{ // stable: пульт отсутствует целиком.
  const { app, page, profile } = await boot('stable');
  try {
    await until(() => page.getByRole('button', { name: 'Настройки', exact: true }).first().isVisible(), 'workspace visible (stable)');
    assert.equal(await page.evaluate(() => Boolean(window.codex.relayBridge)), false, 'stable: no relay bridge in preload');
    assert.equal(await page.evaluate(() => Boolean(window.codex.getRemoteThreadAccess)), false, 'stable: no per-thread access API');
    await page.getByRole('button', { name: 'Настройки', exact: true }).first().click();
    await until(() => page.getByRole('tab', { name: 'Агент', exact: true }).isVisible(), 'settings dialog open (stable)');
    assert.equal(await page.getByRole('tab', { name: 'Телефон', exact: true }).count(), 0, 'stable: no «Телефон» topic');
    await page.getByRole('button', { name: 'Готово', exact: true }).click();
  } finally { await app.close(); }
  // Служба моста не создавалась: её журнал не появился в свежем профиле.
  await assert.rejects(access(path.join(profile, 'remote-bridge', 'bridge.json')), 'stable: bridge service never started');
}

{ // Канал по умолчанию (development): пульт на месте, служба запускается.
  const { app, page, profile } = await boot(undefined);
  try {
    await until(() => page.getByRole('button', { name: 'Настройки', exact: true }).first().isVisible(), 'workspace visible (dev)');
    assert.equal(await page.evaluate(() => Boolean(window.codex.relayBridge)), true, 'dev: relay bridge present');
    assert.equal(await page.evaluate(() => Boolean(window.codex.getRemoteThreadAccess)), true, 'dev: per-thread access API present');
    await page.getByRole('button', { name: 'Настройки', exact: true }).first().click();
    await until(() => page.getByRole('tab', { name: 'Телефон', exact: true }).isVisible(), 'dev: «Телефон» topic present');
    await page.getByRole('button', { name: 'Готово', exact: true }).click();
    await until(() => access(path.join(profile, 'remote-bridge', 'bridge.json')).then(() => true, () => false), 'dev: bridge service journal created');
  } finally { await app.close(); }
}

console.log('ui-phone-pult-channel: OK');
