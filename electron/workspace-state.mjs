import { randomUUID } from 'node:crypto';
import { captureUpdateCheckpoint, createSnapshotStore, validateStoredCheckpoint } from './update-checkpoint.mjs';

export function captureWorkspaceState(snapshot, sessions) {
  return validateStoredCheckpoint(captureUpdateCheckpoint(snapshot, sessions), { resetFullAccess: true });
}
export function createWorkspaceState(userData) {
  return createSnapshotStore(userData, {
    basename: 'workspace-state.json', resetFullAccess: true, preserveInvalid: true,
    readError: "Не удалось восстановить рабочее место. Сохранённый снимок оставлен в папке данных приложения.",
  });
}

/** An unresponsive/crashed renderer leaves the last successful autosave untouched. */
export function createWorkspaceSaveHandshake({ send, save, timeoutMs = 2500 }) {
  const pending = new Map();
  return {
    request(record) {
      if (pending.has(record)) return pending.get(record).promise;
      const requestId = randomUUID();
      let finish;
      const promise = new Promise(resolve => { finish = resolve; });
      const settle = saved => {
        if (pending.get(record)?.requestId !== requestId) return;
        clearTimeout(timer); pending.delete(record); finish(saved);
      };
      const timer = setTimeout(() => settle(false), timeoutMs);
      pending.set(record, { requestId, promise, settle, responding: false });
      try { send(record, { requestId }); } catch { settle(false); }
      return promise;
    },
    async complete(record, response) {
      const current = pending.get(record);
      if (!current || current.responding || response?.requestId !== current.requestId) throw new Error("Сохранение окна уже завершено.");
      current.responding = true;
      if (!response.snapshot) { current.settle(false); return; }
      try { await save(record, response.snapshot); current.settle(true); }
      catch (error) { current.settle(false); throw error; }
    },
    cancel(record) { pending.get(record)?.settle(false); },
  };
}
