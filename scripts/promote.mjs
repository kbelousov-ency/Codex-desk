import { promoteRelease, withReleaseLock } from './release-utils.mjs';

try {
  if (process.argv.length > 2) throw new Error('Команда переноса не принимает аргументы.');
  const result = await withReleaseLock(process.cwd(), () => promoteRelease(process.cwd()));
  console.log(`RELEASE обновлён из проверяемой сборки NIGHTLY ${result.buildId.slice(0, 12)}.\nПриложение: release/stable/Codex Desk.exe\nПредыдущий RELEASE сохранён в release/stable-previous, если он существовал.`);
} catch (error) {
  console.error(`Перенос не завершён: ${error.message}`);
  process.exitCode = 1;
}
