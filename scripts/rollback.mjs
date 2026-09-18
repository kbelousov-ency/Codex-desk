import { rollbackRelease, withReleaseLock } from './release-utils.mjs';

try {
  if (process.argv.length > 2) throw new Error('Команда отката не принимает аргументы.');
  await withReleaseLock(process.cwd(), () => rollbackRelease(process.cwd()));
  console.log('RELEASE и предыдущая сборка поменялись местами. Приложение: release/stable/Codex Desk.exe');
} catch (error) {
  console.error(`Откат не завершён: ${error.message}`);
  process.exitCode = 1;
}
