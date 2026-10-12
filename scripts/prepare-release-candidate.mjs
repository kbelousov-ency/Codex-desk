import { prepareReleaseCandidate } from './release-candidate.mjs';
import { withReleaseLock } from './release-utils.mjs';

try {
  if (process.argv.length > 2) throw new Error('Подготовка Release-кандидата не принимает аргументы.');
  const result = await withReleaseLock(process.cwd(), () => prepareReleaseCandidate(process.cwd()));
  console.log(`Release-кандидат подготовлен: ${result.source}\nСборка: ${result.manifest.buildId}\nПроверьте его перед npm.cmd run release:promote -- --prepared-candidate. Release и очередь Nightly не изменены.`);
} catch (error) {
  console.error(`Release-кандидат не подготовлен: ${error.message}`);
  process.exitCode = 1;
}
