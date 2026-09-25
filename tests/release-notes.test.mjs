import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ReleaseNotesService,
  ReleaseNotesStore,
  collectReleaseChanges,
  parseReleaseNotes,
  readReleaseNotesFile,
} from '../electron/release-notes.mjs';

const changelog = `# Codex Desk\n\n## [0.6.0] — 2026-09-24\n\n- Обновление Codex CLI.\n- Новые модели появляются после переподключения.\n\n## [0.5.1] — 2026-09-22\n\n- Продолжение работы после уточняющего вопроса.\n\n## [0.5.0] — 2026-09-22\n\n- Перетаскивание файлов в окно.\n\n## [0.4.0] — 2026-09-21\n\n- Правила памяти в поставке.\n`;

test('release notes parser keeps versions and user-facing bullet items', () => {
  const releases = parseReleaseNotes(changelog);
  assert.deepEqual(releases.map(release => release.version), ['0.6.0', '0.5.1', '0.5.0', '0.4.0']);
  assert.deepEqual(releases[0].items, ['Обновление Codex CLI.', 'Новые модели появляются после переподключения.']);
  assert.equal(releases[0].date, '2026-09-24');
});

test('release notes parser omits invalid input and duplicate release sections', () => {
  assert.deepEqual(parseReleaseNotes('not a changelog'), []);
  assert.deepEqual(parseReleaseNotes('## [0.6.0]\n\n- One\n\n## [0.6.0]\n\n- Two'), [{ version: '0.6.0', items: ['One'] }]);
});

test('packaged release notes artifact is read offline and missing development artifacts are harmless', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desk-release-notes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'release-notes.json');
  await writeFile(filename, JSON.stringify({ format: 1, releases: parseReleaseNotes(changelog) }));
  assert.deepEqual((await readReleaseNotesFile(filename)).map(release => release.version), ['0.6.0', '0.5.1', '0.5.0', '0.4.0']);
  assert.deepEqual(await readReleaseNotesFile(path.join(directory, 'missing.json')), []);
});

test('collectReleaseChanges returns only versions after the installed version', () => {
  const releases = parseReleaseNotes(changelog);
  assert.deepEqual(collectReleaseChanges(releases, '0.5.1', '0.6.0').map(release => release.version), ['0.6.0']);
  assert.deepEqual(collectReleaseChanges(releases, '0.3.0', '0.6.0').map(release => release.version), ['0.6.0', '0.5.1', '0.5.0', '0.4.0']);
  assert.deepEqual(collectReleaseChanges(releases, '0.6.0', '0.6.0'), []);
});

test('release notes service shows a stable update once and persists acknowledgement', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desk-release-notes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'release-state.json');
  const store = new ReleaseNotesStore(filename);
  const releases = parseReleaseNotes(changelog);
  await store.markSeen('0.5.1');
  const service = new ReleaseNotesService({ channel: 'stable', currentVersion: '0.6.0', releases, store, isNewProfile: false });

  const first = await service.get();
  assert.equal(first.currentVersion, '0.6.0');
  assert.equal(first.previousVersion, '0.5.1');
  assert.equal(first.shouldShow, true);
  assert.deepEqual(first.releases.map(release => release.version), ['0.6.0']);
  await service.acknowledge();
  const manual = await service.get();
  assert.equal(manual.shouldShow, false);
  assert.deepEqual(manual.releases.map(release => release.version), ['0.6.0'], 'Manual access keeps the current release notes available');
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).lastSeenVersion, '0.6.0');
});

test('release notes service does not interrupt first launch or non-stable channels', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desk-release-notes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const releases = parseReleaseNotes(changelog);
  const fresh = new ReleaseNotesService({ channel: 'stable', currentVersion: '0.6.0', releases,
    store: new ReleaseNotesStore(path.join(directory, 'fresh.json')), isNewProfile: true });
  assert.equal((await fresh.get()).shouldShow, false);
  const nightly = new ReleaseNotesService({ channel: 'nightly', currentVersion: '0.6.0', releases,
    store: new ReleaseNotesStore(path.join(directory, 'nightly.json')), isNewProfile: false });
  assert.equal((await nightly.get()).shouldShow, false);
});

test('legacy profile with unknown previous version shows the current release', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desk-release-notes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new ReleaseNotesService({ channel: 'stable', currentVersion: '0.6.0', releases: parseReleaseNotes(changelog),
    store: new ReleaseNotesStore(path.join(directory, 'release-state.json')), isNewProfile: false });
  const state = await service.get();
  assert.equal(state.previousVersion, null);
  assert.equal(state.shouldShow, true);
  assert.deepEqual(state.releases.map(release => release.version), ['0.6.0']);
});

test('acknowledged releases still provide notes for manual reopening', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desk-release-notes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'release-state.json');
  const store = new ReleaseNotesStore(filename);
  await store.markSeen('0.6.0');
  const service = new ReleaseNotesService({ channel: 'stable', currentVersion: '0.6.0', releases: parseReleaseNotes(changelog), store, isNewProfile: false });
  const state = await service.get();
  assert.equal(state.shouldShow, false);
  assert.deepEqual(state.releases.map(release => release.version), ['0.6.0']);
});
