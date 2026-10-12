import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInstallerBranding } from '../scripts/installer-branding.mjs';

const root = process.cwd();

test('Кузьмич: тексты установщика обещают только доступные возможности', async () => {
  const installer = await readFile(path.join(root, 'scripts', 'installer.mjs'), 'utf8');
  const nsis = await readFile(path.join(root, 'scripts', 'installer.nsh'), 'utf8');
  const welcome = installer.match(/!define APP_WELCOME_TEXT "([^"]+)"/)[1];
  const finish = nsis.match(/!if "\$\{APP_FILENAME\}" == "Kuzmich"\s+!define MUI_FINISHPAGE_TEXT "([^"]+)"/)[1];
  assert.equal(welcome, 'Установим Кузьмич. При первом запуске войдите в Portal один раз в окне приложения — Кузьмич сам настроит подключение Codex и Claude.');
  assert.equal(finish, 'Откройте Кузьмич и войдите в Portal один раз в окне приложения — остальное Кузьмич настроит автоматически.$\\r$\\n$\\r$\\nМастер настройки можно открыть снова позже в настройках.');
  assert.doesNotMatch(welcome + finish, /Боцман|Kuzmich|Router/);
  assert.match(installer, /executableName: channel === 'stable' \? 'Codex Desk' : 'Kuzmich'/);
  assert.match(await readFile(path.join(root, 'electron', 'release-channel.mjs'), 'utf8'), /experimental3: 'Kuzmich Experimental 3'/);
});

function bitmap(bytes) {
  assert.equal(bytes.toString('ascii', 0, 2), 'BM');
  assert.equal(bytes.readUInt16LE(28), 24);
  const offset = bytes.readUInt32LE(10), width = bytes.readInt32LE(18), height = bytes.readInt32LE(22);
  const stride = Math.ceil(width * 3 / 4) * 4;
  const pixel = (horizontal, vertical) => {
    const position = offset + (height - 1 - vertical) * stride + horizontal * 3;
    return '#' + [bytes[position + 2], bytes[position + 1], bytes[position]].map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase();
  };
  const colors = new Set();
  for (let vertical = 0; vertical < height; vertical++) for (let horizontal = 0; horizontal < width; horizontal++) colors.add(pixel(horizontal, vertical));
  return { width, height, pixel, colors };
}

test('Кузьмич: BMP-палитра, приватный шрифт и безопасный фолбэк; другие каналы неизменны', { skip: process.platform !== 'win32' }, async context => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'codex-desk-installer-branding-'));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const fixture = path.join(temporary, 'source');
  const fontDirectory = path.join(fixture, 'src', 'assets', 'fonts');
  await mkdir(path.join(fixture, 'electron'), { recursive: true });
  await mkdir(fontDirectory, { recursive: true });
  await copyFile(path.join(root, 'electron', 'icon.ico'), path.join(fixture, 'electron', 'icon.ico'));
  const render = async (name, brand) => {
    const result = await createInstallerBranding(fixture, path.join(temporary, name), brand);
    assert.equal(result.uninstallerSidebar, result.installerSidebar);
    return { sidebar: await readFile(result.installerSidebar), header: await readFile(result.installerHeader) };
  };
  const absent = await render('absent', 'Кузьмич');
  const sidebar = bitmap(absent.sidebar), header = bitmap(absent.header);
  assert.deepEqual([sidebar.width, sidebar.height, header.width, header.height], [164, 314, 150, 57]);
  assert.equal(sidebar.pixel(10, 0), '#171A19');
  assert.equal(header.pixel(0, 0), '#171A19');
  assert.equal(sidebar.pixel(0, 0), '#82968A');
  assert.equal(sidebar.pixel(30, 238), '#3A413D');
  for (const color of ['#D5E0D8', '#929D96']) assert.ok(sidebar.colors.has(color), color);
  assert.ok(header.colors.has('#D5E0D8'));
  const legacy = {};
  for (const brand of ['Codex Desk', 'Codex Desk Nightly']) legacy[brand] = await render('legacy-absent-' + brand, brand);
  const font = path.join(fontDirectory, 'RussoOne-Regular.ttf');
  let fontBytes, fontSource = path.join(root, 'src', 'assets', 'fonts', 'RussoOne-Regular.ttf');
  try { fontBytes = await readFile(fontSource); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fontSource = path.join(process.env.SystemRoot, 'Fonts', 'arial.ttf');
    fontBytes = await readFile(fontSource);
  }
  context.diagnostic('Проверка загрузки приватного шрифта: ' + fontSource);
  await writeFile(font, fontBytes);
  const present = await render('present', 'Кузьмич');
  assert.notDeepEqual(present.sidebar, absent.sidebar, 'Приватный шрифт должен менять словомарку');
  assert.notDeepEqual(present.header, absent.header);
  assert.deepEqual(await render('present-repeat', 'Кузьмич'), present, 'Детерминированные BMP');
  for (const brand of Object.keys(legacy)) {
    const result = await render('legacy-present-' + brand, brand);
    assert.deepEqual(result, legacy[brand], brand);
    assert.equal(bitmap(result.sidebar).pixel(10, 0), '#141618');
    assert.equal(bitmap(result.header).pixel(0, 0), '#181A1C');
  }
  await writeFile(font, 'повреждённый шрифт');
  assert.deepEqual(await render('invalid-font', 'Кузьмич'), absent, 'Повреждённый шрифт тоже возвращает Segoe UI bold');
});
