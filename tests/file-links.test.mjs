import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { localLinkCandidates, openLink, resolveLocalLink, showLocalPathMenu } from '../electron/file-links.mjs';

async function fixture(t) {
  const base = await mkdtemp(path.join(process.cwd(), 'artifacts', 'file-links-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'Проект с пробелами');
  await mkdir(cwd);
  const target = path.join(cwd, 'Пример файла.txt');
  const executable = path.join(cwd, 'Codex Desk.exe');
  await writeFile(target, 'a fixture, not an actual model request');
  await writeFile(executable, 'a harmless text fixture');
  return { base, cwd, target, executable };
}

test('Windows Markdown paths, file URLs and source locations become local absolute candidates', () => {
  const cwd = 'E:\\My projects\\CodexDesk';
  const expected = 'E:\\My projects\\CodexDesk\\src\\Пример файла.ts';
  for (const input of [
    'src/Пример файла.ts',
    'src/Пример%20файла.ts:12:4',
    'E:/My projects/CodexDesk/src/Пример файла.ts:12',
    'E:\\My projects\\CodexDesk\\src\\Пример файла.ts:12',
    '/E:/My%20projects/CodexDesk/src/%D0%9F%D1%80%D0%B8%D0%BC%D0%B5%D1%80%20%D1%84%D0%B0%D0%B9%D0%BB%D0%B0.ts',
    'file:///E:/My%20projects/CodexDesk/src/Пример%20файла.ts:12',
  ]) assert.ok(localLinkCandidates(input, cwd, path.win32).includes(expected), input);
  assert.deepEqual(localLinkCandidates('src/Пример файла.ts#L12', cwd, path.win32), [`${expected}#L12`, expected]);
  assert.deepEqual(localLinkCandidates('file:///E:/My%20projects/CodexDesk/src/Пример%20файла.ts#L12', cwd, path.win32), [`${expected}#L12`, expected]);
});

test('parser rejects network paths, device files, bad schemes and control characters', () => {
  for (const input of [
    '\\\\server\\share\\file.txt', '//server/share/file.txt', '%2f%2fserver/share/file.txt',
    '\\\\?\\C:\\file.txt', '\\\\.\\NUL', '\\??\\C:\\file.txt', '\\Device\\HarddiskVolume1\\file.txt',
    'file://server/share/file.txt', 'file:////server/share/file.txt', 'file:///C:/project/a.txt?query=1',
    'javascript:alert(1)', 'data:text/html,<h1>hello</h1>', 'vscode://file/C:/project/a.txt',
    'NUL.txt', 'sub/COM1', 'LPT9.log', 'file.txt:stream', 'bad%00file.txt', 'bad\nfile.txt', '', null,
  ]) assert.throws(() => localLinkCandidates(input, 'C:\\project', path.win32), undefined, String(input));
});

test('existing local paths accept encoded Unicode/spaces and strip source positions', async t => {
  const { cwd, target } = await fixture(t);
  const canonical = await realpath(target);
  for (const input of [target, path.basename(target), encodeURIComponent(path.basename(target)), `${target}:12`, `${target}:12:3`, `${target}#L12`, `${target}#L12-L15`, `${pathToFileURL(target)}#L12`]) {
    assert.equal(await resolveLocalLink(input, cwd), canonical, input);
  }
  assert.equal(await resolveLocalLink('.', cwd), await realpath(cwd));
});

test('absolute Markdown links with encoded parent folders open and reveal the decoded local file', async t => {
  const { cwd, target } = await fixture(t);
  const canonical = await realpath(target);
  const encoded = pathToFileURL(target).pathname;
  const links = [encoded, `${encoded}:12:3`, `${encoded}#L12`];
  if (process.platform === 'win32') links.push(encoded.slice(1), encoded.slice(1).replaceAll('/', '\\'));
  const calls = [];
  const shell = {
    openPath: async value => { calls.push(['open', value]); return ''; },
    showItemInFolder: value => calls.push(['reveal', value]),
  };
  const Menu = menuFixture((item, options) => { item.click(); options.callback(); });
  for (const link of links) {
    assert.equal(await resolveLocalLink(link, cwd), canonical, link);
    await openLink({ target: link, cwd, shell });
    await showLocalPathMenu({ target: link, cwd, shell, Menu });
  }
  assert.deepEqual(calls, links.flatMap(() => [['open', canonical], ['reveal', canonical]]));
});

test('literal # filenames win over source position suffixes', async t => {
  const { cwd, target } = await fixture(t);
  const hashFile = `${target}#L12`;
  await writeFile(hashFile, 'literal hash filename');
  const expected = await realpath(hashFile);
  assert.equal(await resolveLocalLink(hashFile, cwd), expected);
  assert.equal(await resolveLocalLink(pathToFileURL(hashFile).href, cwd), expected);
  assert.equal(await resolveLocalLink(`${pathToFileURL(target)}#L12`, cwd), expected);
});

test('literal percent names remain usable while file URLs decode percent escapes once', async t => {
  const { cwd } = await fixture(t);
  const literal = path.join(cwd, 'space%20name.txt');
  const spaced = path.join(cwd, 'space name.txt');
  await writeFile(literal, 'literal percent');
  await writeFile(spaced, 'actual space');
  assert.equal(await resolveLocalLink(literal, cwd), await realpath(literal));
  assert.equal(await resolveLocalLink(pathToFileURL(literal).href, cwd), await realpath(literal));
  assert.equal(await resolveLocalLink(pathToFileURL(spaced).href, cwd), await realpath(spaced));
});

test('missing paths, traversal and cross-project symlinks cannot reach the shell', async t => {
  const { base, cwd } = await fixture(t);
  const outside = path.join(base, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'private.txt'), 'outside project');
  await assert.rejects(resolveLocalLink('missing.txt', cwd), /не найдены/);
  await assert.rejects(resolveLocalLink('../outside/private.txt', cwd), /за пределами/);
  await assert.rejects(resolveLocalLink(path.join(outside, 'private.txt'), cwd), /за пределами/);
  const shell = {
    openPath: () => assert.fail('outside files must not be opened'),
    showItemInFolder: () => assert.fail('outside files must not be revealed'),
  };
  const Menu = {
    buildFromTemplate: items => {
      assert.deepEqual(items.map(item => item.label), ['Копировать ссылку', 'Спросить Codex', 'Открыть в проводнике']);
      assert.notEqual(items[0].enabled, false, 'Copying text is allowed outside the project');
      for (const item of items.slice(1)) assert.equal(item.enabled, false, `${item.label} must stay unavailable outside the project`);
      return { popup: options => options.callback() };
    },
  };
  for (const target of [
    '%2e%2e%2foutside%2fprivate.txt',
    `${pathToFileURL(cwd).pathname}/%2e%2e/outside/private.txt`,
    pathToFileURL(path.join(outside, 'private.txt')).pathname,
  ]) {
    await assert.rejects(resolveLocalLink(target, cwd), /за пределами/);
    await assert.rejects(openLink({ target, cwd, shell }), /за пределами/);
    assert.equal(await showLocalPathMenu({ target, cwd, shell, Menu, options: { askCodex: true } }), undefined);
  }
  const link = path.join(cwd, 'junction');
  try { await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.diagnostic(`Symlink assertion unavailable: ${error.code}`); return; }
    throw error;
  }
  await assert.rejects(resolveLocalLink('junction/private.txt', cwd), /за пределами/);
  const encodedLink = pathToFileURL(path.join(link, 'private.txt')).pathname;
  await assert.rejects(resolveLocalLink(encodedLink, cwd), /за пределами/);
  await assert.rejects(openLink({ target: encodedLink, cwd, shell }), /за пределами/);
  assert.equal(await showLocalPathMenu({ target: encodedLink, cwd, shell, Menu, options: { askCodex: true } }), undefined);
});

test('opening invokes shell.openPath for files including executables and openExternal only for HTTP(S)', async t => {
  const { cwd, target, executable } = await fixture(t);
  const calls = [];
  const shell = {
    openPath: async value => { calls.push(['open', value]); return ''; },
    openExternal: async value => { calls.push(['web', value]); },
    showItemInFolder: () => assert.fail('left click must open the file'),
  };
  await openLink({ target: `${target}:12`, cwd, shell });
  await openLink({ target: executable, cwd, shell });
  await openLink({ target: 'https://example.com/path', shell });
  assert.deepEqual(calls, [['open', await realpath(target)], ['open', await realpath(executable)], ['web', 'https://example.com/path']]);
  await assert.rejects(openLink({ target: 'javascript:alert(1)', cwd, shell }));
  assert.equal(calls.length, 3);
  await assert.rejects(openLink({ target, cwd, shell: { openPath: async () => 'No application is associated' } }), /Не удалось открыть файл: No application is associated/);
  await assert.rejects(openLink({ target, cwd, shell, assertActive: () => { throw new Error('tab closed'); } }), /tab closed/);
  assert.equal(calls.length, 3);
});

function menuFixture(onPopup) {
  return {
    buildFromTemplate: items => {
      assert.deepEqual(items.map(item => item.label), ['Копировать ссылку', 'Открыть в проводнике']);
      const reveal = items.find(item => item.label === 'Открыть в проводнике');
      assert.notEqual(reveal.enabled, false);
      return { popup: options => onPopup(reveal, options) };
    },
  };
}

test('native path menu reveals the selected file and cancellation also resolves', async t => {
  const { cwd, target } = await fixture(t);
  const revealed = [];
  const shell = { showItemInFolder: value => revealed.push(value) };
  const window = { id: 123 };
  const Menu = menuFixture((item, options) => {
    assert.equal(options.window, window);
    item.click();
    options.callback();
  });
  assert.equal(await showLocalPathMenu({ target, cwd, shell, Menu, window }), undefined);
  assert.deepEqual(revealed, [await realpath(target)]);
  assert.equal(await showLocalPathMenu({ target, cwd, shell, window, Menu: menuFixture((_item, options) => options.callback()) }), undefined);
  assert.equal(revealed.length, 1);
  // Native closure can notify before delivering the selected item's click.
  await showLocalPathMenu({ target, cwd, shell, window, Menu: menuFixture((item, options) => {
    options.callback();
    queueMicrotask(() => item.click());
  }) });
  assert.equal(revealed.length, 2);
});

test('native menu propagates shell errors and checks file existence again after choosing', async t => {
  const { cwd, target } = await fixture(t);
  const Menu = menuFixture((item, options) => { item.click(); options.callback(); });
  await assert.rejects(showLocalPathMenu({ target, cwd, Menu, shell: { showItemInFolder: () => { throw new Error('Explorer failed'); } } }), /Explorer failed/);
  let select;
  const pending = showLocalPathMenu({
    target, cwd, shell: { showItemInFolder: () => assert.fail('missing file must not be revealed') },
    Menu: menuFixture((item, options) => { select = () => { item.click(); options.callback(); }; }),
  });
  while (!select) await new Promise(resolve => setImmediate(resolve));
  await unlink(target);
  select();
  await assert.rejects(pending, /не найдены/);
});

function askMenuFixture(onPopup) {
  return {
    buildFromTemplate: items => {
      assert.deepEqual(items.map(item => item.label), ['Копировать ссылку', 'Спросить Codex', 'Открыть в проводнике']);
      for (const item of items) assert.notEqual(item.enabled, false);
      return { popup: options => onPopup(items, options) };
    },
  };
}

test('Ask Codex returns canonical paths for files and folders without launching native file actions', async t => {
  const { cwd, target } = await fixture(t);
  const shell = {
    openPath: () => assert.fail('Ask Codex must not open a file'),
    showItemInFolder: () => assert.fail('Ask Codex must not reveal a file'),
  };
  const Menu = askMenuFixture((items, options) => {
    // Native closure can notify before delivering the selected item's click.
    options.callback();
    queueMicrotask(() => items.find(item => item.label === 'Спросить Codex').click());
  });
  for (const input of [path.basename(target), '.']) {
    assert.deepEqual(await showLocalPathMenu({ target: input, cwd, shell, Menu, options: { askCodex: true } }), {
      action: 'askCodex', path: await realpath(path.resolve(cwd, input)),
    });
  }
});

test('Ask Codex menu cancellation and reveal resolve without an action result; opt-out keeps the original menu', async t => {
  const { cwd, target } = await fixture(t);
  const revealed = [];
  const shell = { showItemInFolder: value => revealed.push(value) };
  const options = { askCodex: true };
  assert.equal(await showLocalPathMenu({ target, cwd, shell, options, Menu: askMenuFixture((_items, popup) => popup.callback()) }), undefined);
  assert.deepEqual(revealed, []);
  assert.equal(await showLocalPathMenu({ target, cwd, shell, options, Menu: askMenuFixture((items, popup) => {
    items.find(item => item.label === 'Открыть в проводнике').click(); popup.callback();
  }) }), undefined);
  assert.deepEqual(revealed, [await realpath(target)]);
  assert.equal(await showLocalPathMenu({ target, cwd, shell, options: { askCodex: false }, Menu: menuFixture((_item, popup) => popup.callback()) }), undefined);
});

test('Ask Codex rechecks file existence after the native menu opens', async t => {
  const { cwd, target } = await fixture(t);
  let opened;
  const ready = new Promise(resolve => { opened = resolve; });
  let select;
  const pending = showLocalPathMenu({ target, cwd, options: { askCodex: true }, Menu: askMenuFixture((items, popup) => {
    select = () => { items.find(item => item.label === 'Спросить Codex').click(); popup.callback(); };
    opened();
  }) });
  await ready;
  await unlink(target);
  select();
  await assert.rejects(pending, /не найдены/);
});

test('Ask Codex rejects a closed session or changed working folder after the native menu opens', async t => {
  const { cwd, target } = await fixture(t);
  for (const message of ['Вкладка закрыта.', 'Рабочая папка изменилась.']) {
    let active = true;
    let checks = 0;
    await assert.rejects(showLocalPathMenu({ target, cwd, options: { askCodex: true },
      assertActive: () => { checks++; if (!active) throw new Error(message); },
      Menu: askMenuFixture((items, popup) => { active = false; items.find(item => item.label === 'Спросить Codex').click(); popup.callback(); }),
    }), { message });
    assert.equal(checks, 2, 'The session is checked before opening the menu and again before returning the selected path');
  }
});


function copyMenuFixture(onPopup, checkItems = () => {}) {
  return {
    buildFromTemplate: items => {
      assert.equal(items[0].label, 'Копировать ссылку');
      assert.notEqual(items[0].enabled, false);
      checkItems(items);
      return { popup: options => onPopup(items[0], options) };
    },
  };
}

test('copy preserves HTTP(S), encoded local paths, file URLs and source positions without opening them', async t => {
  const { cwd, target } = await fixture(t);
  const copied = [];
  const clipboard = { writeText: value => { copied.push(value); } };
  const shell = {
    openPath: () => assert.fail('Copy must not open a file'),
    openExternal: () => assert.fail('Copy must not open a browser'),
    showItemInFolder: () => assert.fail('Copy must not reveal a file'),
  };
  const links = [
    'https://EXAMPLE.test/a%20b?q=%D1%82%D0%B5%D1%81%D1%82&x=1#section',
    'http://example.test:80/path?key=value#L12',
    target,
    `${encodeURIComponent(path.basename(target))}:12:4`,
    `${pathToFileURL(target).pathname}#L12-L15`,
    `${pathToFileURL(target).href}#L12`,
  ];
  for (const link of links) {
    const web = /^https?:/.test(link);
    const Menu = copyMenuFixture((item, popup) => {
      // The close callback may arrive just before the selected item's click.
      popup.callback();
      queueMicrotask(() => item.click());
    }, items => {
      assert.deepEqual(items.map(item => item.label), web ? ['Копировать ссылку'] : ['Копировать ссылку', 'Спросить Codex', 'Открыть в проводнике']);
      for (const item of items) assert.notEqual(item.enabled, false);
    });
    assert.equal(await showLocalPathMenu({ target: link, cwd, shell, clipboard, Menu, options: { askCodex: true } }), undefined);
    assert.equal(copied.at(-1), link, 'The complete original href is copied without URL normalization or removing source positions');
  }
  assert.deepEqual(copied, links);
});

test('missing files, links outside the project and unavailable projects remain copyable with file actions disabled', async t => {
  const { base, cwd, target } = await fixture(t);
  const outside = path.join(base, 'outside.txt');
  await writeFile(outside, 'outside the project');
  const cases = [
    { target: 'missing.txt', cwd },
    { target: outside, cwd },
    { target: '../outside.txt', cwd },
    { target: `${pathToFileURL(outside).pathname}:18`, cwd },
    { target, cwd: path.join(base, 'missing-project') },
    { target, cwd: undefined },
  ];
  const copied = [];
  const clipboard = { writeText: value => { copied.push(value); } };
  const shell = {
    openPath: () => assert.fail('Unavailable files must not be opened'),
    showItemInFolder: () => assert.fail('Unavailable files must not be revealed'),
  };
  const Menu = copyMenuFixture((item, popup) => { item.click(); popup.callback(); }, items => {
    assert.deepEqual(items.map(item => item.label), ['Копировать ссылку', 'Спросить Codex', 'Открыть в проводнике']);
    for (const item of items.slice(1)) assert.equal(item.enabled, false);
  });
  for (const input of cases) assert.equal(await showLocalPathMenu({ ...input, shell, clipboard, Menu, options: { askCodex: true } }), undefined);
  assert.deepEqual(copied, cases.map(input => input.target));
});

test('copy menu cancellation leaves the clipboard untouched, including after an unavailable file lookup', async t => {
  const { cwd, target } = await fixture(t);
  const clipboard = { writeText: () => assert.fail('Cancellation must not overwrite the clipboard') };
  const Menu = copyMenuFixture((_item, popup) => popup.callback());
  for (const link of ['https://example.test/path', target, 'missing.txt']) {
    assert.equal(await showLocalPathMenu({ target: link, cwd, clipboard, Menu }), undefined);
  }
});

test('copy still works if a file disappears while its native menu is open', async t => {
  const { cwd, target } = await fixture(t);
  const copied = [];
  let opened;
  const ready = new Promise(resolve => { opened = resolve; });
  let select;
  const pending = showLocalPathMenu({ target, cwd, clipboard: { writeText: value => { copied.push(value); } },
    Menu: copyMenuFixture((item, popup) => {
      select = () => { item.click(); popup.callback(); };
      opened();
    }),
  });
  await ready;
  await unlink(target);
  select();
  assert.equal(await pending, undefined);
  assert.deepEqual(copied, [target]);
});

test('copy rejects a stale session before display or selection and propagates clipboard failures', async t => {
  const { cwd, target } = await fixture(t);
  const clipboard = { writeText: () => assert.fail('A stale session must not overwrite the clipboard') };
  await assert.rejects(showLocalPathMenu({ target, cwd, clipboard,
    assertActive: () => { throw new Error('Вкладка закрыта.'); },
    Menu: { buildFromTemplate: () => assert.fail('A closed session must not open its menu') },
  }), /Вкладка закрыта/);
  for (const link of [target, 'https://example.test/path', 'missing.txt']) {
    for (const message of ['Вкладка закрыта.', 'Рабочая папка изменилась.']) {
      let active = true;
      await assert.rejects(showLocalPathMenu({ target: link, cwd, clipboard,
        assertActive: () => { if (!active) throw new Error(message); },
        Menu: copyMenuFixture((item, popup) => { active = false; item.click(); popup.callback(); }),
      }), { message });
    }
  }
  await assert.rejects(showLocalPathMenu({ target, cwd,
    clipboard: { writeText: () => { throw new Error('Clipboard unavailable'); } },
    Menu: copyMenuFixture((item, popup) => { item.click(); popup.callback(); }),
  }), /Clipboard unavailable/);
});

test('invalid clipboard targets are rejected before the native menu is shown', async () => {
  const Menu = { buildFromTemplate: () => assert.fail('Invalid text must not reach a native menu') };
  const clipboard = { writeText: () => assert.fail('Invalid text must not be copied') };
  for (const target of ['', '  ', null, 42, 'x'.repeat(32769), 'https://example.test/\ntext', 'bad\u0000path']) {
    await assert.rejects(showLocalPathMenu({ target, clipboard, Menu }), /Некорректная ссылка или путь/);
  }
});
