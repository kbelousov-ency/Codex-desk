import { applyNightlyUpdate, discardNightlyUpdate, logUpdate } from './nightly-update.mjs';

const root = process.cwd();
try {
  if (process.argv.length === 3 && process.argv[2] === '--discard') {
    await discardNightlyUpdate(root);
    console.log('Ожидающая сборка Nightly удалена. Установленные Nightly и Release не изменены.');
  } else {
    if (process.argv.length > 2) throw new Error('Допустим только параметр --discard для отмены незавершённой очереди.');
    const result = await applyNightlyUpdate(root);
    console.log(`NIGHTLY обновлён${result.restarted ? ' и перезапущен' : ''}. RELEASE не изменён.`);
  }
} catch (error) {
  await logUpdate(root, 'helper_stopped').catch(() => {});
  console.error(`Обновление Nightly остановлено: ${error.message}\nПовтор: node scripts/apply-nightly-update.mjs. Отмена очереди: node scripts/apply-nightly-update.mjs --discard. Журнал: artifacts/nightly-update.log.`);
  process.exitCode = 1;
}
