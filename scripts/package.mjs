import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';

import { checkedTree, fileChecksums, publishNightly, removeChecked, withReleaseLock } from './release-utils.mjs';
import { assertNoPendingUpdate, findNightlyInstance, launchUpdateHelper, queueNightlyUpdate } from './nightly-update.mjs';

// Only Nightly is built from source. Release is promoted from these exact bytes.
const root = process.cwd();
let queuedBuildId;
try {
  if (process.argv.length > 2) throw new Error('Сборка всегда обновляет release/nightly. Произвольный каталог вывода больше не поддерживается.');
  await withReleaseLock(root, async () => {
    await assertNoPendingUpdate(root);
    await findNightlyInstance(root);
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const work = path.join(root, 'artifacts', 'channel-build');
    await removeChecked(root, work);
    const stage = path.join(work, 'app');
    const output = path.join(work, 'output');
    await mkdir(stage, { recursive: true });
    for (const directory of ['dist', 'electron']) {
      await checkedTree(root, path.join(root, directory));
      await cp(path.join(root, directory), path.join(stage, directory), { recursive: true });
    }
    // Renderer dependencies are bundled by Vite; the host needs the TOML parser.
    await checkedTree(root, path.join(root, 'node_modules', '@iarna', 'toml'));
    await mkdir(path.join(stage, 'node_modules', '@iarna'), { recursive: true });
    await cp(path.join(root, 'node_modules', '@iarna', 'toml'), path.join(stage, 'node_modules', '@iarna', 'toml'), { recursive: true });
    await writeFile(path.join(stage, 'package.json'), JSON.stringify({
      name: manifest.name, version: manifest.version, description: manifest.description,
      private: true, type: manifest.type, main: manifest.main,
      dependencies: { '@iarna/toml': manifest.dependencies['@iarna/toml'] },
    }, null, 2));
    const checksums = await fileChecksums(root, stage, new Set(['electron/build-info.json']));
    const buildId = createHash('sha256').update(JSON.stringify(checksums)).digest('hex');
    await writeFile(path.join(stage, 'electron', 'build-info.json'), JSON.stringify({ buildId, builtAt: new Date().toISOString(), version: manifest.version }, null, 2));
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        path.join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'),
        '--win', '--dir', `--config.directories.app=${stage}`, `--config.directories.output=${output}`,
      ], { cwd: root, stdio: 'inherit', windowsHide: true });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`electron-builder завершился с кодом ${code}.`)));
    });
    const instance = await findNightlyInstance(root);
    if (instance) {
      await queueNightlyUpdate(root, path.join(output, 'win-unpacked'), instance);
      queuedBuildId = buildId;
    } else {
      await publishNightly(root, path.join(output, 'win-unpacked'));
      console.log(`NIGHTLY обновлён: release/nightly/Codex Desk.exe\nСборка: ${buildId.slice(0, 12)}. RELEASE не изменён.`);
    }
    await removeChecked(root, work);
  });
  if (queuedBuildId) {
    await launchUpdateHelper(root);
    console.log(`NIGHTLY собран. Обновление применится автоматически после завершения активных задач и перезапустит приложение.\nСборка: ${queuedBuildId.slice(0, 12)}. RELEASE не изменён.`);
  }
} catch (error) {
  console.error(`Сборка не опубликована: ${error.message}`);
  if (queuedBuildId) console.error('Готовая сборка сохранена в очереди. Повторите node scripts/apply-nightly-update.mjs.');
  process.exitCode = 1;
}
