import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';

import { checkedTree, fileChecksums, publishChannel, removeChecked, withReleaseLock } from './release-utils.mjs';
import { assertNoPendingUpdate, findNightlyInstance, launchUpdateHelper, queueNightlyUpdate } from './nightly-update.mjs';

import { assertReleaseVersion } from './release-version.mjs';
import { parseReleaseNotes } from '../electron/release-notes.mjs';
import { applicationBuildIdentity } from '../electron/app-identity.mjs';

// Review channels are built from source. Only Release-compatible bytes can be promoted.
const root = process.cwd();
let queuedBuildId;
try {
  if (process.argv.length > 2 && process.argv[2] !== '--experimental3') throw new Error('Допустим только флаг --experimental3.');
  const channel = process.argv[2] === '--experimental3' ? 'experimental3' : 'nightly';
  const branding = applicationBuildIdentity(channel);
  await withReleaseLock(root, async () => {
    await assertNoPendingUpdate(root);
    if (channel === 'nightly') await findNightlyInstance(root);
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    assertReleaseVersion(manifest.version);
    const work = path.join(root, 'artifacts', 'channel-build');
    await removeChecked(root, work);
    const stage = path.join(work, 'app');
    const output = path.join(work, 'output');
    await mkdir(stage, { recursive: true });
    for (const directory of ['dist', 'electron']) {
      await checkedTree(root, path.join(root, directory));
      await cp(path.join(root, directory), path.join(stage, directory), { recursive: true });
    }
    // Keep release notes offline and versioned with the exact bytes that are
    // packaged. Development builds fall back to CHANGELOG.md in the host.
    const releaseNotes = parseReleaseNotes(await readFile(path.join(root, 'CHANGELOG.md'), 'utf8'));
    if (!releaseNotes.length) throw new Error('CHANGELOG.md не содержит заметок релиза.');
    await writeFile(path.join(stage, 'electron', 'release-notes.json'), `${JSON.stringify({ format: 1, releases: releaseNotes }, null, 2)}\n`);
    // Renderer dependencies are bundled by Vite; the host needs the TOML parser.
    await checkedTree(root, path.join(root, 'node_modules', '@iarna', 'toml'));
    await mkdir(path.join(stage, 'node_modules', '@iarna'), { recursive: true });
    await cp(path.join(root, 'node_modules', '@iarna', 'toml'), path.join(stage, 'node_modules', '@iarna', 'toml'), { recursive: true });
    // Only the self-contained SDK history reader is packaged. Claude execution
    // uses the user's installed CLI; no optional SDK binaries are shipped.
    const claudeSdk = path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
    await checkedTree(root, claudeSdk);
    const stagedSdk = path.join(stage, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
    await mkdir(stagedSdk, { recursive: true });
    for (const file of ['sdk.mjs', 'README.md']) await cp(path.join(claudeSdk, file), path.join(stagedSdk, file));
    await writeFile(path.join(stagedSdk, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.3.278', type: 'module', main: 'sdk.mjs', exports: './sdk.mjs' }));
    await writeFile(path.join(stage, 'package.json'), JSON.stringify({
      name: manifest.name, version: manifest.version, description: manifest.description,
      private: true, type: manifest.type, main: manifest.main,
      dependencies: { '@iarna/toml': manifest.dependencies['@iarna/toml'], '@anthropic-ai/claude-agent-sdk': manifest.dependencies['@anthropic-ai/claude-agent-sdk'] },
    }, null, 2));
    const checksums = await fileChecksums(root, stage, new Set(['electron/build-info.json']));
    const buildId = createHash('sha256').update(JSON.stringify({ files: checksums, branding })).digest('hex');
    // Jenkins задаёт BUILD_NUMBER; сборка запоминает его, чтобы установленная копия
    // могла отличить себя от другой заливки той же X.Y.Z в каталоге роутера.
    const buildNumber = /^[1-9]\d{0,9}$/.test(process.env.BUILD_NUMBER ?? '') ? Number(process.env.BUILD_NUMBER) : null;
    await writeFile(path.join(stage, 'electron', 'build-info.json'), JSON.stringify({ buildId, builtAt: new Date().toISOString(), version: manifest.version, productName: branding.productName, iconName: branding.iconName, ...(buildNumber ? { buildNumber } : {}) }, null, 2));
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        path.join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'),
        '--win', '--dir', `--config.directories.app=${stage}`, `--config.directories.output=${output}`,
        `--config.productName=${branding.productName}`,
        `--config.executableName=${branding.executableName}`,
        `--config.win.icon=electron/${branding.iconName}`,
      ], { cwd: root, stdio: 'inherit', windowsHide: true });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`electron-builder завершился с кодом ${code}.`)));
    });
    const instance = channel === 'nightly' ? await findNightlyInstance(root) : null;
    if (instance) {
      await queueNightlyUpdate(root, path.join(output, 'win-unpacked'), instance);
      queuedBuildId = buildId;
    } else {
      await publishChannel(root, path.join(output, 'win-unpacked'), channel);
      const executableName = channel === 'stable' ? 'Codex Desk.exe' : 'Kuzmich.exe';
      console.log(`Канал ${channel} обновлён: release/${channel}/${executableName}\nСборка: ${buildId.slice(0, 12)}. RELEASE не изменён.`);
    }
    await removeChecked(root, work);
  });
  if (queuedBuildId) {
    await launchUpdateHelper(root);
    console.log(`NIGHTLY собран. В новой версии закрытие для обновления подтверждается в чате; старое приложение нужно закрыть вручную. До закрытия сборка остаётся в очереди.\nСборка: ${queuedBuildId.slice(0, 12)}. RELEASE не изменён.`);
  }
} catch (error) {
  console.error(`Сборка не опубликована: ${error.message}`);
  if (queuedBuildId) console.error('Готовая сборка сохранена в очереди. Повторите node scripts/apply-nightly-update.mjs.');
  process.exitCode = 1;
}
