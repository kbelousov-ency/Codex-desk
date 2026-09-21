import { cp, lstat, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { checkedPath, removeChecked, verifyRelease, withReleaseLock } from './release-utils.mjs';
import { createInstallerBranding } from './installer-branding.mjs';
import { installerFilename } from './release-version.mjs';

// Default distributes approved Release bytes; --nightly produces an isolated
// review installer. Neither mode compiles renderer or promotes a release.
const root = process.cwd();
try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--nightly')) throw new Error('Допустим только --nightly для пробного установщика. Без аргументов используется утверждённый release/stable.');
  const channel = args[0] === '--nightly' ? 'nightly' : 'stable';
  const label = channel === 'nightly' ? 'Codex Desk Nightly' : 'Codex Desk';
  await withReleaseLock(root, async () => {
    let source = path.join(root, 'release', channel);
    let queuedBuildId;
    if (channel === 'nightly') {
      const queueFile = path.join(root, 'artifacts', 'nightly-update', 'state.json');
      await checkedPath(root, queueFile);
      let stat;
      try { stat = await lstat(queueFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat) {
        if (!stat.isFile() || stat.size > 16384) throw new Error('Неверный файл очереди Nightly.');
        const queue = JSON.parse(await readFile(queueFile, 'utf8'));
        if (queue.version !== 1 || !/^[a-f0-9]{64}$/.test(queue.buildId)) throw new Error('Очередь Nightly повреждена.');
        source = path.join(root, 'artifacts', 'nightly-update', 'app');
        queuedBuildId = queue.buildId;
      }
    }
    const approved = await verifyRelease(root, source, channel);
    if (queuedBuildId && approved.buildId !== queuedBuildId) throw new Error('Кандидат Nightly не совпадает с очередью обновления.');
    const work = path.join(root, 'artifacts', 'installer-build');
    await removeChecked(root, work);
    const snapshot = path.join(work, channel);
    const metadata = path.join(work, 'metadata');
    const output = path.join(work, 'output');
    await mkdir(metadata, { recursive: true });
    await cp(source, snapshot, { recursive: true });
    await verifyRelease(root, snapshot, channel);
    const sourcePackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    await writeFile(path.join(metadata, 'package.json'), JSON.stringify({
      name: channel === 'nightly' ? `${sourcePackage.name}-nightly` : sourcePackage.name, version: approved.version, description: sourcePackage.description,
      main: 'electron/main.mjs', author: 'Codex Desk contributors',
      homepage: 'https://github.com/kbelousov-ency/Codex-desk',
    }));
    const filename = installerFilename(approved.version, channel);
    const branding = await createInstallerBranding(root, path.join(work, 'branding'));
    // Keep the approved executable filename while giving the candidate its own
    // installation folder. Preserve the original Release default for upgrades.
    const include = path.join(work, 'installer.nsh');
    await writeFile(include, `!undef APP_FILENAME\n!define APP_FILENAME "${channel === 'nightly' ? 'Codex Desk Nightly' : 'codex-desk'}"\n!include "${path.join(root, 'scripts', 'installer.nsh')}"\n`);
    const config = {
      extends: null,
      appId: `local.codex.desk.${channel}`, productName: label, executableName: 'Codex Desk',
      directories: { app: metadata, output, buildResources: path.join(root, 'electron') },
      electronVersion: JSON.parse(await readFile(path.join(root, 'node_modules/electron/package.json'), 'utf8')).version,
      win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: path.join(root, 'electron/icon.ico'), signAndEditExecutable: false, signExecutable: false },
      nsis: {
        oneClick: false, perMachine: false, allowElevation: false, packElevateHelper: false,
        allowToChangeInstallationDirectory: false,
        createDesktopShortcut: 'always', createStartMenuShortcut: true, shortcutName: label,
        runAfterFinish: true, deleteAppDataOnUninstall: false, differentialPackage: false,
        displayLanguageSelector: false, installerLanguages: ['ru_RU', 'en_US'], language: '1049',
        artifactName: filename, uninstallDisplayName: label,
        installerIcon: path.join(root, 'electron/icon.ico'), uninstallerIcon: path.join(root, 'electron/icon.ico'),
        ...branding, include,
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
    // Prepackaged mode must preserve every approved file and the channel marker.
    await verifyRelease(root, snapshot, channel);
    await verifyRelease(root, source, channel);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path.join(output, filename))) hash.update(chunk);
    const sha256 = hash.digest('hex');
    const size = (await lstat(path.join(output, filename))).size;
    const delivery = channel === 'nightly' ? path.join(root, 'artifacts', 'installer-nightly') : path.join(root, 'release', 'installer');
    const next = channel === 'nightly' ? path.join(root, 'artifacts', '.installer-nightly-incoming') : path.join(root, 'release', '.installer-incoming');
    await removeChecked(root, next);
    await mkdir(next);
    await cp(path.join(output, filename), path.join(next, filename));
    await writeFile(path.join(next, 'SHA256SUMS.txt'), `${sha256}  ${filename}\n`);
    await writeFile(path.join(next, 'release-info.json'), JSON.stringify({ format: 1, channel, version: approved.version, buildId: approved.buildId, builtAt: approved.builtAt, installer: filename, sha256, size }, null, 2));
    await writeFile(path.join(next, 'README.txt'), '\uFEFF' + [
      `${label} — установка для Windows 10/11, x64`, '',
      `1. Запустите ${filename}.`,
      '2. Пройдите мастер установки. Программа установится для текущего пользователя и создаст ярлыки.',
      '3. Откройте приложение. При первом запуске мастер настройки предложит установить Codex и Claude CLI, применить конфигурацию Codex и войти в аккаунт.',
      'Node.js и папка исходников на компьютере получателя не нужны.', '',
      'Для выбранного агента нужен его CLI: уже установленный либо выбранный в мастере. Для загрузки CLI нужен интернет.',
      'Файл конфигурации Codex можно скачать с https://coder-portal.encycam.com и выбрать в мастере.',
      'Существующий config.toml заменяется только после подтверждения; перед заменой сохраняется резервная копия.',
      'Авторизация, ключи и настройки автора в установщик не включены.',
      'Мастер можно повторно открыть в настройках приложения.', '',
      'Установка без прав администратора. Удаление доступно в параметрах Windows → Приложения.',
      'При обновлении закройте установленный Codex Desk и запустите новый установщик.',
      `Этот же exe подходит для первой установки и обновления ${channel === 'nightly' ? 'установленного Nightly. Пробный установщик не обновляет Release' : 'существующего Release'}.`,
      'Настройки, история Codex и вложения при удалении программы сохраняются.', '',
      'Установщик пока не подписан сертификатом издателя; Windows может показать предупреждение.',
      `Версия: ${approved.version}. Сборка: ${approved.buildId}.`,
    ].join('\r\n'));
    await removeChecked(root, delivery);
    await rename(next, delivery);
    console.log(`Готов установщик: ${path.join(delivery, filename)}\n${channel}: ${approved.buildId.slice(0, 12)}\nSHA-256: ${sha256}`);
  });
} catch (error) { console.error(`Не удалось собрать установщик: ${error.message}`); process.exitCode = 1; }
