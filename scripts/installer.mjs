import { cp, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { removeChecked, verifyRelease, withReleaseLock } from './release-utils.mjs';

// Distribute the approved Release bytes. Never build renderer or promote Nightly here.
const root = process.cwd();
try {
  if (process.argv.length > 2) throw new Error('Установщик создаётся только из текущего release/stable.');
  await withReleaseLock(root, async () => {
    const stable = path.join(root, 'release', 'stable');
    const approved = await verifyRelease(root, stable, 'stable');
    const work = path.join(root, 'artifacts', 'installer-build');
    await removeChecked(root, work);
    const snapshot = path.join(work, 'stable');
    const metadata = path.join(work, 'metadata');
    const output = path.join(work, 'output');
    await mkdir(metadata, { recursive: true });
    await cp(stable, snapshot, { recursive: true });
    await verifyRelease(root, snapshot, 'stable');
    const sourcePackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    await writeFile(path.join(metadata, 'package.json'), JSON.stringify({
      name: sourcePackage.name, version: approved.version, description: sourcePackage.description,
      main: 'electron/main.mjs', author: 'Codex Desk contributors',
      homepage: 'https://github.com/kbelousov-ency/Codex-desk',
    }));
    const filename = `Codex Desk Setup ${approved.version}.exe`;
    const config = {
      extends: null,
      appId: 'local.codex.desk.stable', productName: 'Codex Desk',
      directories: { app: metadata, output, buildResources: path.join(root, 'electron') },
      electronVersion: JSON.parse(await readFile(path.join(root, 'node_modules/electron/package.json'), 'utf8')).version,
      win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: path.join(root, 'electron/icon.ico'), signAndEditExecutable: false, signExecutable: false },
      nsis: {
        oneClick: true, perMachine: false, allowElevation: false, packElevateHelper: false,
        createDesktopShortcut: 'always', createStartMenuShortcut: true, shortcutName: 'Codex Desk',
        runAfterFinish: true, deleteAppDataOnUninstall: false, differentialPackage: false,
        displayLanguageSelector: false, installerLanguages: ['ru_RU', 'en_US'], language: '1049',
        artifactName: filename, uninstallDisplayName: 'Codex Desk',
        include: path.join(root, 'scripts/installer.nsh'),
      },
      publish: null,
    };
    const configPath = path.join(work, 'installer-config.json');
    await writeFile(configPath, JSON.stringify(config, null, 2));
    const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, 'node_modules/electron-builder/out/cli/cli.js'),
        '--win', 'nsis', '--x64', '--prepackaged', snapshot, '--config', configPath, '--publish', 'never'],
      { cwd: root, env, stdio: 'inherit', windowsHide: true });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Упаковка установщика завершилась с кодом ${code}.`)));
    });
    // Prepackaged mode must preserve every approved file (including the stable marker).
    await verifyRelease(root, snapshot, 'stable');
    await verifyRelease(root, stable, 'stable');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path.join(output, filename))) hash.update(chunk);
    const sha256 = hash.digest('hex');
    const delivery = path.join(root, 'release', 'installer');
    const next = path.join(root, 'release', '.installer-incoming');
    await removeChecked(root, next);
    await mkdir(next);
    await cp(path.join(output, filename), path.join(next, filename));
    await writeFile(path.join(next, 'SHA256SUMS.txt'), `${sha256}  ${filename}\n`);
    await writeFile(path.join(next, 'release-info.json'), JSON.stringify({ channel: 'stable', version: approved.version, buildId: approved.buildId, builtAt: approved.builtAt, installer: filename, sha256 }, null, 2));
    await writeFile(path.join(next, 'README.txt'), '\uFEFF' + [
      'Codex Desk — установка для Windows 10/11, x64', '',
      `1. Запустите ${filename}.`,
      '2. Программа установится для текущего пользователя, создаст ярлыки и откроется.',
      'Node.js и папка исходников на компьютере получателя не нужны.', '',
      'Для работы с моделью нужен установленный и настроенный Codex CLI: личный вход или корпоративная конфигурация.',
      'Авторизация, ключи и настройки автора в установщик не включены.',
      'Если Codex не найден, выберите codex.exe в настройках приложения.', '',
      'Установка без прав администратора. Удаление доступно в параметрах Windows → Приложения.',
      'При обновлении закройте установленный Codex Desk и запустите новый установщик.',
      'Настройки, история Codex и вложения при удалении программы сохраняются.', '',
      'Установщик пока не подписан сертификатом издателя; Windows может показать предупреждение.',
      `Версия: ${approved.version}. Сборка: ${approved.buildId}.`,
    ].join('\r\n'));
    await removeChecked(root, delivery);
    await rename(next, delivery);
    console.log(`Готов установщик: ${path.join(delivery, filename)}\nRelease: ${approved.buildId.slice(0, 12)}\nSHA-256: ${sha256}`);
  });
} catch (error) { console.error(`Не удалось собрать установщик: ${error.message}`); process.exitCode = 1; }
