import { cp, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkedTree, removeChecked, verifyRelease, withReleaseLock } from './release-utils.mjs';
import { assertReleaseVersion, installerFilename } from './release-version.mjs';

const REPOSITORY = 'https://github.com/kbelousov-ency/Codex-desk';

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function releaseNotes(changelog, version) {
  assertReleaseVersion(version);
  const sections = [...changelog.matchAll(/^## \[([^\]]+)\][^\r\n]*\r?\n/gm)];
  const index = sections.findIndex(section => section[1] === version);
  if (index < 0 || sections.filter(section => section[1] === version).length !== 1) {
    throw new Error(`В CHANGELOG.md нужен один раздел ## [${version}].`);
  }
  const section = sections[index];
  const body = changelog.slice(section.index + section[0].length, sections[index + 1]?.index).trim();
  if (!body) throw new Error(`Раздел CHANGELOG.md для ${version} пуст.`);
  return `# Codex Desk ${version}\n\n${body}\n`;
}

// This prepares local review files only. Approval, git tag and GitHub publication
// remain separate from packaging and must be explicitly requested by the user.
export async function prepareRelease(root) {
  return withReleaseLock(root, async () => {
    const approved = await verifyRelease(root, path.join(root, 'release', 'stable'), 'stable');
    const version = assertReleaseVersion(approved.version);
    const source = path.join(root, 'release', 'installer');
    await checkedTree(root, source);
    const infoFile = path.join(source, 'release-info.json');
    if ((await lstat(infoFile)).size > 16384) throw new Error('Метаданные установщика слишком велики.');
    const info = JSON.parse(await readFile(infoFile, 'utf8'));
    const filename = installerFilename(version);
    const acceptedNames = [filename, `Codex Desk Setup ${version}.exe`, `Codex.Desk.Setup.${version}.exe`];
    if (info.channel !== 'stable' || (info.format !== undefined && info.format !== 1)
      || ['version', 'buildId', 'builtAt'].some(key => info[key] !== approved[key])
      || !acceptedNames.includes(info.installer) || !/^[a-f0-9]{64}$/.test(info.sha256)) {
      throw new Error('Установщик не соответствует утверждённому Release. Выполните release:installer.');
    }
    const setup = path.join(source, info.installer);
    const stat = await lstat(setup);
    if (!stat.isFile() || stat.size <= 0 || (info.size !== undefined && info.size !== stat.size)
      || await sha256File(setup) !== info.sha256) {
      throw new Error('Размер или SHA-256 установщика не совпадает. Выполните release:installer.');
    }
    const notes = releaseNotes(await readFile(path.join(root, 'CHANGELOG.md'), 'utf8'), version);
    const readme = (await readFile(path.join(source, 'README.txt'), 'utf8')).replaceAll(info.installer, filename);
    const metadata = { format: 1, channel: 'stable', version, buildId: approved.buildId, builtAt: approved.builtAt,
      installer: filename, sha256: info.sha256, size: stat.size };
    const output = path.join(root, 'artifacts', 'github-release');
    const next = path.join(root, 'artifacts', '.github-release-incoming');
    await removeChecked(root, next);
    await mkdir(next, { recursive: true });
    await cp(setup, path.join(next, filename));
    if (await sha256File(path.join(next, filename)) !== metadata.sha256) throw new Error('Копия установщика повреждена.');
    await writeFile(path.join(next, 'release-info.json'), `${JSON.stringify(metadata, null, 2)}\n`);
    await writeFile(path.join(next, 'SHA256SUMS.txt'), `${metadata.sha256}  ${filename}\n`);
    await writeFile(path.join(next, 'README.txt'), readme);
    await writeFile(path.join(next, 'RELEASE_NOTES.md'), notes);
    await removeChecked(root, output);
    await rename(next, output);
    return { ...metadata, tag: `v${version}`, output, url: `${REPOSITORY}/releases/tag/v${version}` };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 2) throw new Error('Подготовка выпуска не принимает аргументы.');
    const result = await prepareRelease(process.cwd());
    console.log(`Файлы ${result.tag} подготовлены: ${result.output}\nСборка: ${result.buildId.slice(0, 12)}\nSHA-256: ${result.sha256}\nПубликация и git tag не выполнялись.`);
  } catch (error) {
    console.error(`Не удалось подготовить выпуск: ${error.message}`);
    process.exitCode = 1;
  }
}
