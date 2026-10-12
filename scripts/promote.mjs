import { promoteRelease, withReleaseLock } from './release-utils.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--prepared-candidate')) throw new Error('Допустим только --prepared-candidate для отдельно подготовленного и проверенного Release-кандидата.');
  const result = await withReleaseLock(process.cwd(), () => promoteRelease(process.cwd(), { preparedCandidate: args.length === 1 }));
  console.log(`RELEASE обновлён из проверяемой сборки ${result.buildId.slice(0, 12)}.\nПриложение: release/stable/Codex Desk.exe\nПредыдущий RELEASE сохранён в release/stable-previous, если он существовал.`);
} catch (error) {
  console.error(`Перенос не завершён: ${error.message}`);
  process.exitCode = 1;
}
