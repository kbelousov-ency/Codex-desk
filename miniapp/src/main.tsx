import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { getTelegramContext, loadTelegramSdk } from './telegram';
import './styles.css';

async function bootstrap() {
  try { await loadTelegramSdk(); } catch { /* Render an actionable auth/connection state. */ }
  let telegram = getTelegramContext();
  if (import.meta.env.VITE_LOCAL_RELAY === '1' && import.meta.env.DEV && !telegram.isFixture) {
    try {
      const response = await fetch(`${import.meta.env.VITE_RELAY_URL || '/api'}/dev/init-data`);
      if (!response.ok) throw new Error('Local fixture unavailable');
      const { initData } = await response.json() as { initData: string };
      telegram = { initData, startParam: new URLSearchParams(initData).get('start_param') || undefined, isFixture: false, webApp: { initData } };
    } catch { telegram = { initData: '', isFixture: false, webApp: { initData: '' } }; }
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App telegram={telegram} /></React.StrictMode>);
}

void bootstrap();
