import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bulkArchiveReport, bulkBlockReason, bulkScopeKey, bulkScopeLabel, bulkThreadTitle, conversationCount,
  keepSelectable, planBulkArchive, sameBulkScope, selectableIds, toggleSelection,
} from '../src/bulk-archive.ts';

const folder = 'C:/Fixtures/PROJECT_A';
const row = (id, extra = {}) => ({ thread: { id, name: `Диалог ${id}`, ...extra }, cwd: folder });
const folderName = cwd => cwd.split('/').pop();

test('a scope key ignores Windows separators, trailing slashes and case, but not a different query', () => {
  assert.equal(bulkScopeKey({ kind: 'folder', cwd: 'C:\\Fixtures\\PROJECT_A\\' }), bulkScopeKey({ kind: 'folder', cwd: 'c:/fixtures/project_a' }));
  assert.equal(sameBulkScope({ kind: 'folder', cwd: folder }, { kind: 'folder', cwd: folder }), true);
  assert.equal(sameBulkScope({ kind: 'folder', cwd: folder }, { kind: 'search', query: folder }), false);
  assert.equal(sameBulkScope({ kind: 'search', query: ' Отчёт ' }, { kind: 'search', query: 'отчёт' }), true);
  assert.equal(sameBulkScope({ kind: 'search', query: 'отчёт' }, { kind: 'search', query: 'отчет' }), false);
  assert.equal(sameBulkScope(null, { kind: 'folder', cwd: folder }), false);
  assert.equal(sameBulkScope(null, null), false);
});

test('the scope is always spelled out, never implied', () => {
  assert.equal(bulkScopeLabel({ kind: 'folder', cwd: folder }, folderName), 'папка PROJECT_A');
  assert.equal(bulkScopeLabel({ kind: 'search', query: 'отчёт' }, folderName), 'результаты поиска «отчёт»');
});

test('counts are declined in Russian for the confirmation text', () => {
  assert.deepEqual([1, 2, 4, 5, 11, 14, 21, 22, 100, 101].map(conversationCount), [
    '1 диалог', '2 диалога', '4 диалога', '5 диалогов', '11 диалогов', '14 диалогов',
    '21 диалог', '22 диалога', '100 диалогов', '101 диалог',
  ]);
});

test('unsupported and protected conversations are never selectable', () => {
  assert.equal(bulkBlockReason({ id: 'a' }, folder), '');
  assert.equal(bulkBlockReason({ id: 'a', archived: true }, folder), 'уже в архиве');
  assert.equal(bulkBlockReason({ id: 'a' }, '   '), 'нет рабочей папки');
  assert.equal(bulkBlockReason({ id: 'a' }, folder, id => id === 'a'), 'идёт работа, ожидается подтверждение или открыт терминал');
  // A busy conversation outranks nothing else: the folder check comes first on purpose.
  assert.equal(bulkBlockReason({ id: 'a', archived: true }, '', () => true), 'уже в архиве');
});

test('select all covers exactly the loaded, allowed conversations of the scope', () => {
  const rows = [row('a'), row('b'), { thread: { id: 'c' }, cwd: '' }, row('d', { archived: true }), row('e')];
  assert.deepEqual(selectableIds(rows, id => id === 'e'), ['a', 'b']);
  assert.deepEqual(selectableIds(rows), ['a', 'b', 'e']);
});

test('toggling one conversation keeps the rest of the selection', () => {
  assert.deepEqual(toggleSelection([], 'a'), ['a']);
  assert.deepEqual(toggleSelection(['a', 'b'], 'c'), ['a', 'b', 'c']);
  assert.deepEqual(toggleSelection(['a', 'b', 'c'], 'b'), ['a', 'c']);
});

test('a stale pick is dropped once the row leaves the list or becomes busy', () => {
  const rows = [row('a'), row('b')];
  assert.deepEqual(keepSelectable(['a', 'gone', 'b'], rows), ['a', 'b']);
  assert.deepEqual(keepSelectable(['a', 'b'], rows, id => id === 'b'), ['a']);
});

test('the plan resolves picks against the visible rows, in visible order', () => {
  const rows = [row('b'), row('a'), row('c')];
  const plan = planBulkArchive({ rows, selected: ['a', 'c', 'b', 'vanished'], names: { a: 'Переименованный' } });
  assert.deepEqual(plan.targets.map(target => target.id), ['b', 'a', 'c']);
  assert.deepEqual(plan.blocked, []);
  assert.equal(plan.targets[1].title, 'Переименованный', 'A pending rename is shown, not the stale server name');
  assert.equal(plan.targets[0].cwd, folder, 'Every target carries the folder the archive call needs');
});

test('busy, archived and folderless picks are reported as skipped instead of archived', () => {
  const rows = [row('a'), row('busy'), row('old', { archived: true }), { thread: { id: 'loose', name: 'Без папки' }, cwd: '' }];
  const plan = planBulkArchive({ rows, selected: ['a', 'busy', 'old', 'loose'], locked: id => id === 'busy' });
  assert.deepEqual(plan.targets.map(target => target.id), ['a']);
  assert.deepEqual(plan.blocked.map(entry => [entry.id, entry.reason]), [
    ['busy', 'идёт работа, ожидается подтверждение или открыт терминал'],
    ['old', 'уже в архиве'],
    ['loose', 'нет рабочей папки'],
  ]);
});

test('a duplicated row cannot produce two archive calls for one conversation', () => {
  const plan = planBulkArchive({ rows: [row('a'), row('a')], selected: ['a'] });
  assert.deepEqual(plan.targets.map(target => target.id), ['a']);
});

test('an empty selection plans nothing', () => {
  assert.deepEqual(planBulkArchive({ rows: [row('a')], selected: [] }), { targets: [], blocked: [] });
});

test('titles fall back from name to preview to the default label', () => {
  assert.equal(bulkThreadTitle({ id: 'a', name: 'Имя', preview: 'Превью' }), 'Имя');
  assert.equal(bulkThreadTitle({ id: 'a', preview: 'Превью' }), 'Превью');
  assert.equal(bulkThreadTitle({ id: 'a' }), 'Новый диалог');
  assert.equal(bulkThreadTitle({ id: 'a', name: 'Имя' }, { a: 'Локальное' }), 'Локальное');
});

const target = id => ({ id, cwd: folder, title: `Диалог ${id}` });

test('a partial failure keeps the successes and names what stayed behind', () => {
  const report = bulkArchiveReport({
    outcomes: [{ ...target('a'), ok: true }, { ...target('b'), ok: false, error: 'Дождитесь завершения работы диалога.' }, { ...target('c'), ok: true }],
    total: 3,
  });
  assert.equal(report.archived, 2);
  assert.deepEqual(report.failed.map(entry => entry.id), ['b']);
  assert.equal(report.untouched, 0);
  assert.equal(report.message, 'Архивировано: 2 из 3. Не удалось: 1.');
});

test('a full success reports no failures', () => {
  const report = bulkArchiveReport({ outcomes: [{ ...target('a'), ok: true }], total: 1 });
  assert.deepEqual(report, { archived: 1, failed: [], untouched: 0, message: 'Архивировано: 1 из 1.' });
});

test('stopping mid-run reports the untouched remainder separately from failures', () => {
  const report = bulkArchiveReport({ outcomes: [{ ...target('a'), ok: true }], total: 4, stopped: true });
  assert.equal(report.message, 'Архивировано: 1 из 4. Остановлено, не обработано: 3.');
  assert.equal(bulkArchiveReport({ outcomes: [{ ...target('a'), ok: true }], total: 4 }).message, 'Архивировано: 1 из 4. Не обработано: 3.');
});

test('conversations skipped before the run are counted apart from the attempted ones', () => {
  const report = bulkArchiveReport({
    outcomes: [{ ...target('a'), ok: true }], total: 1,
    blocked: [{ ...target('busy'), reason: 'идёт работа, ожидается подтверждение или открыт терминал' }],
  });
  assert.equal(report.message, 'Архивировано: 1 из 1. Пропущено как занятые или неподдерживаемые: 1.');
});

test('nothing archived is stated plainly rather than as a success', () => {
  const report = bulkArchiveReport({ outcomes: [{ ...target('a'), ok: false, error: 'Fixture archive failed' }], total: 1 });
  assert.equal(report.archived, 0);
  assert.equal(report.message, 'Архивировано: 0 из 1. Не удалось: 1.');
});
