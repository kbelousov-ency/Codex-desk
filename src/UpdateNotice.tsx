import { createContext, useContext } from 'react';
import { X } from 'lucide-react';
import type { UpdateStatus } from './types';

type UpdateControl = { status: UpdateStatus | null; deciding: boolean; decide(value: 'close' | 'later'): void; dismiss(): void };
export const UpdateNoticeContext = createContext<UpdateControl | null>(null);

export default function UpdateNotice() {
  const control = useContext(UpdateNoticeContext);
  if (!control?.status || control.status.state === 'preparing') return null;
  const { status, deciding, decide, dismiss } = control;
  const message = status.message || (status.state === 'awaiting'
    ? 'Обновление Nightly готово. Закрыть приложение и применить его? Вкладки и черновики сохранятся.'
    : status.state === 'waiting'
      ? 'Обновление ждёт завершения задач и редактирования. Затем приложение закроется и откроется снова.'
      : status.state === 'manual'
        ? 'Обновление будет применено, когда вы сами закроете приложение.'
        : 'Не удалось применить обновление. Приложение продолжает работать.');
  return <div className={`alert ${status.state === 'error' ? 'error-alert' : 'notice-alert'} nightly-update-notice`} role="status" aria-label="Обновление Nightly">
    <span>{message}</span>
    {status.state === 'awaiting' && <button type="button" className="continue-button" disabled={deciding} onClick={() => decide('close')}>Закрыть</button>}
    {(status.state === 'awaiting' || status.state === 'waiting')
      ? <button type="button" className="continue-button" disabled={deciding} onClick={() => decide('later')}>Отмена</button>
      : <button type="button" className="icon-button small" aria-label="Скрыть сообщение об обновлении" onClick={dismiss}><X size={14} /></button>}
  </div>;
}
