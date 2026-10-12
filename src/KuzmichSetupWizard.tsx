import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckCheck, CircleAlert, CircleCheck, Download, FolderOpen, KeyRound, LoaderCircle, LogIn, PlugZap, RefreshCw, Settings2, ShieldCheck, Terminal, X } from 'lucide-react';
import './product-logo.css';
import AgentLogo from './AgentLogo';
import { useProductName, useProductNameGenitive } from './BuildInfo';
import { useKuzmichTheme } from './kuzmich-theme';
import type { AgentProvider } from './types';
import type { PortalConnectProductState, PortalConnectStatus, PortalSessionStatus, SetupComponentId, SetupProgress, SetupScan } from './setup-types';
import './setup-wizard.css';

/**
 * Experimental 3 wizard: the user only signs in, Kuzmich does the rest itself.
 * «CLI» → «Вход» → «Подключение» → «Готово». The connect step is the plan's path A:
 * the host writes both CLI configurations programmatically from the portal cookie, so
 * the only thing this step asks of the user is a single click (and a retry on failure).
 */
const steps = [
  { label: 'CLI', detail: 'Выбор и установка', icon: Terminal },
  { label: 'Вход', detail: 'Один вход в Portal', icon: KeyRound },
  { label: 'Подключение', detail: 'Кузьмич настроит сам', icon: PlugZap },
  { label: 'Готово', detail: 'Можно начинать', icon: CheckCheck },
];
const CONNECT_POLL_MS = 1000;
const names: Record<SetupComponentId, string> = { codex: 'Codex CLI', claude: 'Claude Code CLI', git: 'Git' };
const providers: AgentProvider[] = ['codex', 'claude'];
const keyLabels: Record<PortalSessionStatus['keyState'], string> = {
  approved: 'Ключ роутера активен',
  pending: 'Ключ ждёт одобрения администратора портала',
  none: 'Ключ роутера пока не выдан',
  'held-elsewhere': 'Ключ роутера выдан на другую почту',
};
const connectLabels: Record<PortalConnectProductState['state'], string> = {
  idle: 'Ещё не подключён',
  working: 'Подключаем…',
  done: 'Подключён через роутер',
  error: 'Подключить не удалось',
  skipped: 'Пропущен',
};
const errorText = (cause: unknown) => cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Не удалось выполнить действие. Попробуйте ещё раз.';

export default function KuzmichSetupWizard({ onClose, initial = false }: { onClose: (provider?: AgentProvider) => void; initial?: boolean }) {
  const bridge = window.codex?.setup;
  const [step, setStep] = useState(0);
  const [scan, setScan] = useState<SetupScan | null>(null);
  const [selected, setSelected] = useState<Record<SetupComponentId, boolean>>({ codex: true, claude: true, git: false });
  const [operation, setOperation] = useState<string | null>('scan');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<Partial<Record<SetupComponentId, SetupProgress>>>({});
  const [installErrors, setInstallErrors] = useState<Partial<Record<SetupComponentId, string>>>({});
  const [session, setSession] = useState<PortalSessionStatus | null>(null);
  const [portalOperation, setPortalOperation] = useState<string | null>(null);
  const [loginPending, setLoginPending] = useState(false);
  const [connect, setConnect] = useState<PortalConnectStatus | null>(null);
  const [connectPending, setConnectPending] = useState(false);
  const [noBridge, setNoBridge] = useState(false);
  const [preferred, setPreferred] = useState<AgentProvider>('codex');
  const [providerTouched, setProviderTouched] = useState(false);
  const productName = useProductName();
  const productOf = useProductNameGenitive();
  // Этот мастер существует только в канале «Кузьмича», поэтому тему он включает сам —
  // в том числе когда UI-тест монтирует его без App.
  useKuzmichTheme(true);
  const mounted = useRef(false);
  const operationLock = useRef(false);
  const portalLock = useRef(false);
  const connectLock = useRef(false);
  const sessionRead = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const errorBanner = useRef<HTMLDivElement>(null);
  const dismiss = useRef(() => {});
  const connectRunning = connect?.running ?? false;
  const busy = Boolean(operation) || Boolean(portalOperation) || loginPending || connectPending || connectRunning;
  const installed = (id: SetupComponentId) => scan?.components.some(component => component.id === id && component.status === 'installed') ?? false;
  const available = providers.filter(installed);
  const pending = providers.filter(id => selected[id] && !installed(id));
  const signedIn = session?.state === 'signed-in';
  const waitingForLogin = loginPending || session?.state === 'signing-in';
  const keyApproved = signedIn && session?.keyState === 'approved';
  /** Installed ∩ allowed by the portal: exactly what the host is asked to connect. */
  const connectable = available.filter(provider => Boolean(session?.products[provider]));
  // A product the portal refuses is reported as skipped even before the host says so.
  const connectState = (provider: AgentProvider): PortalConnectProductState =>
    connect?.products[provider] ?? (session?.products[provider]
      ? { state: 'idle' }
      : { state: 'skipped', message: 'Portal не даёт доступ к этому агенту' });
  const connectStates = available.map(connectState);
  const anyWorking = connectStates.some(state => state.state === 'working');
  const retryable = connectStates.some(state => state.state === 'error' || state.state === 'idle');

  const run = useCallback(async (name: string, action: () => Promise<void>) => {
    if (operationLock.current || portalLock.current || connectLock.current) return;
    operationLock.current = true;
    setOperation(name); setError('');
    try { await action(); }
    catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally {
      operationLock.current = false;
      if (mounted.current) setOperation(null);
    }
  }, []);

  /** Portal actions take their own lock: the sign-in window must stay reachable while it waits. */
  const runPortal = useCallback(async (name: string, action: () => Promise<PortalSessionStatus | void>) => {
    if (!bridge || operationLock.current || portalLock.current || connectLock.current) return;
    portalLock.current = true;
    setPortalOperation(name); setError('');
    try {
      const result = await action();
      if (result && mounted.current) setSession(result);
    } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally {
      portalLock.current = false;
      if (mounted.current) setPortalOperation(null);
    }
  }, [bridge]);

  const refresh = () => run('scan', async () => {
    if (!bridge) throw new Error(`Мастер настройки доступен в установленном приложении ${productName}.`);
    const result = await bridge.scan();
    if (mounted.current) { setScan(result); setInstallErrors({}); setProgress({}); }
  });

  useEffect(() => {
    mounted.current = true;
    let active = true;
    operationLock.current = true;
    const unsubscribe = bridge?.onProgress(event => { if (active) setProgress(current => ({ ...current, [event.component]: event })); });
    if (bridge) {
      bridge.state().then(state => { if (active && state.preferredProvider) setPreferred(state.preferredProvider); }).catch(() => {});
      bridge.scan().then(result => { if (active) setScan(result); })
        .catch(cause => { if (active) setError(errorText(cause)); })
        .finally(() => { if (active) { operationLock.current = false; setOperation(null); } });
    } else {
      // Rendered, not stored: the product name arrives with the build info, after this runs.
      setOperation(null); operationLock.current = false; setNoBridge(true);
    }
    return () => { active = false; mounted.current = false; unsubscribe?.(); };
  }, [bridge]);

  // Opening the sign-in page reads the stored session once; it never starts a login by itself.
  useEffect(() => {
    if (step !== 1 || sessionRead.current || !bridge) return;
    sessionRead.current = true;
    void runPortal('session', () => bridge.portalSession());
  }, [step, bridge, runPortal]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    title.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss.current(); }
      if (event.key !== 'Tab') return;
      const nodes = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]') || []).filter(node => node.getClientRects().length > 0);
      const first = nodes[0]; const last = nodes[nodes.length - 1];
      if (!first) { event.preventDefault(); title.current?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !nodes.includes(document.activeElement as HTMLElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !nodes.includes(document.activeElement as HTMLElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => { document.removeEventListener('keydown', handleKey, true); if (previous?.isConnected) previous.focus(); };
  }, []);

  useEffect(() => { title.current?.focus(); setError(''); }, [step]);
  useEffect(() => { if (error) errorBanner.current?.scrollIntoView({ block: 'nearest' }); }, [error]);
  const availableKey = available.join(',');
  useEffect(() => {
    if (availableKey && !availableKey.split(',').includes(preferred)) setPreferred(availableKey.split(',')[0] as AgentProvider);
  }, [availableKey, preferred]);

  const finish = (deferred = false) => {
    if (!bridge) { onClose(); return; }
    void run('complete', async () => {
      const provider = !deferred && (initial || providerTouched) && available.includes(preferred) ? preferred : undefined;
      await bridge.complete({ provider, deferred });
      if (mounted.current) onClose(provider);
    });
  };
  dismiss.current = () => { if (!busy) finish(true); };

  const next = () => setStep(current => Math.min(current + 1, steps.length - 1));
  const installSelected = () => run('install', async () => {
    if (!bridge || !scan) return;
    let failed = false;
    for (const id of pending) {
      setInstallErrors(current => ({ ...current, [id]: undefined }));
      try {
        const result = await bridge.install(id);
        if (!mounted.current) return;
        setScan(result);
        if (!result.components.some(component => component.id === id && component.status === 'installed')) {
          failed = true;
          setInstallErrors(current => ({ ...current, [id]: 'Установка не подтверждена. Проверьте ещё раз или укажите путь к программе.' }));
        }
      } catch (cause) {
        if (!mounted.current) return;
        failed = true;
        setInstallErrors(current => ({ ...current, [id]: errorText(cause) }));
        setProgress(current => ({ ...current, [id]: { component: id, stage: 'error', message: 'Установка не завершена' } }));
      }
    }
    if (!failed) next();
  });
  const chooseExecutable = (id: SetupComponentId) => run(`choose-${id}`, async () => {
    const result = await bridge?.chooseExecutable(id);
    if (mounted.current && result) {
      setScan(result);
      setInstallErrors(current => ({ ...current, [id]: undefined }));
      setProgress(current => ({ ...current, [id]: undefined }));
    }
  });

  /** The sign-in window lives in the host; this promise settles when the host closes it. */
  const login = () => {
    if (!bridge || operationLock.current || portalLock.current) return;
    portalLock.current = true;
    setLoginPending(true); setError('');
    void bridge.portalLogin()
      .then(result => { if (mounted.current) setSession(result); })
      .catch(cause => { if (mounted.current) setError(errorText(cause)); })
      .finally(() => { portalLock.current = false; if (mounted.current) setLoginPending(false); });
  };
  const focusLogin = () => { void bridge?.focusPortalLogin().catch(() => {}); };
  const recheck = () => runPortal('session', () => bridge!.portalSession({ refresh: true }));
  const requestKey = () => runPortal('request-key', () => bridge!.portalRequestKey());
  const logout = () => runPortal('logout', () => bridge!.portalLogout());

  /** The host writes the configs; `running` drives the poll below until it flips false. */
  const startConnect = (products?: AgentProvider[]) => {
    if (!bridge || operationLock.current || portalLock.current || connectLock.current) return;
    const wanted = products ?? connectable;
    if (!wanted.length) return;
    connectLock.current = true;
    setConnectPending(true); setError('');
    void bridge.portalConnect({ products: wanted })
      .then(result => { if (mounted.current) setConnect(result); })
      .catch(cause => { if (mounted.current) setError(errorText(cause)); })
      .finally(() => { connectLock.current = false; if (mounted.current) setConnectPending(false); });
  };

  // Sequential polling: a new request is scheduled only after the previous reply lands,
  // and it stops the moment the host reports the run finished, the step changes or we unmount.
  useEffect(() => {
    if (step !== 2 || !connectRunning || !bridge) return;
    let active = true;
    let timer: number | undefined;
    const tick = async () => {
      if (!active) return;
      try {
        const result = await bridge.portalConnectStatus();
        if (!active) return;
        setConnect(result);
        if (result.running) timer = window.setTimeout(() => void tick(), CONNECT_POLL_MS);
      } catch (cause) {
        if (!active) return;
        setError(errorText(cause));
        // A status we cannot read must not leave the footer locked forever.
        setConnect(current => current ? { ...current, running: false } : current);
      }
    };
    timer = window.setTimeout(() => void tick(), CONNECT_POLL_MS);
    return () => { active = false; window.clearTimeout(timer); };
  }, [step, connectRunning, bridge]);

  const titles = ['Установим нужные CLI', 'Один вход в Portal', 'Кузьмич подключит CLI', available.length ? 'Всё готово к работе' : 'Настройка сохранена'];
  const subtitles = [
    'Выберите агентов, с которыми хотите работать. Уже установленные программы подключатся автоматически.',
    `Дальше Кузьмич всё делает сам — от вас нужен только вход. Окно входа открывается внутри ${productOf}, пароль остаётся у Portal.`,
    'Настройки для установленных CLI Кузьмич получит с Portal и запишет сам. Прежние файлы сохранит в резервные копии, ваши остальные настройки оставит как есть.',
    'Ниже — результат настройки. К этому мастеру всегда можно вернуться из настроек приложения.',
  ];
  const keyState = session?.keyState;

  return <div className="setup-overlay">
    <div className="setup-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="kuzmich-title" aria-describedby="kuzmich-description" aria-busy={busy} data-step={step} data-wizard="kuzmich">
      <aside className="setup-sidebar" aria-label="Этапы настройки">
        <div className="setup-brand"><span className="setup-brand-mark kuzmich-setup-brand-mark"><img src={new URL('../electron/kuzmich-logo.svg', import.meta.url).href} width={32} height={32} alt="" aria-hidden="true" /></span><span className="setup-brand-word">Кузьмич</span></div>
        <div className="setup-sidebar-caption">ВАШЕ РАБОЧЕЕ МЕСТО</div>
        <ol className="setup-steps">{steps.map((item, index) => <li key={item.label} className={index === step ? 'is-current' : index < step ? 'is-complete' : ''} aria-current={index === step ? 'step' : undefined}>
          <span className="setup-step-symbol">{index < step ? <Check size={17} /> : <item.icon size={17} />}</span><span><strong>{item.label}</strong><small>{item.detail}</small></span>
        </li>)}</ol>
        <div className="setup-sidebar-note"><ShieldCheck size={19} /><p>Один вход.<br />Остальное Кузьмич<br />делает сам.</p></div>
        <span className="setup-sidebar-bottom">НАСТРОЙКА {productOf.toUpperCase()}</span>
      </aside>
      <div className="setup-main">
        <header className="setup-header"><span>ШАГ {step + 1} ИЗ {steps.length}</span><button className="setup-icon-button" aria-label={initial ? 'Настроить позже' : 'Закрыть мастер настройки'} disabled={busy} onClick={() => finish(true)}><X size={18} /></button></header>
        <div className="setup-body">
          <h1 id="kuzmich-title" ref={title} tabIndex={-1}>{titles[step]}</h1>
          <p id="kuzmich-description" className="setup-description">{subtitles[step]}</p>
          {(error || noBridge) && <div className="setup-alert is-error" role="alert" ref={errorBanner}><CircleAlert size={17} /><span>{error || `Мастер настройки доступен в установленном приложении ${productName}.`}</span></div>}

          {step === 0 && <>
            {!scan ? <div className="setup-scan-placeholder" role="status">{operation === 'scan' ? <><LoaderCircle className="setup-spin" size={23} /><span>Проверяем установленные программы…</span></> : <><CircleAlert size={23} /><span>Не удалось проверить программы</span><button className="setup-button" onClick={() => void refresh()}>Попробовать снова</button></>}</div> : <>
              <div className="setup-agent-list">{providers.map(id => {
                const component = scan.components.find(item => item.id === id);
                const found = installed(id);
                const activeProgress = progress[id];
                const running = operation === 'install' && activeProgress && ['installing', 'checking'].includes(activeProgress.stage);
                const detail = installErrors[id] || (component?.status === 'error' ? component.message : '');
                return <section className={`setup-agent-card${found || selected[id] ? ' is-selected' : ''}`} key={id} data-component={id}>
                  <label className="setup-agent-choice"><input type="checkbox" checked={found || selected[id]} disabled={busy || found || !scan.platformSupported} onChange={event => setSelected(current => ({ ...current, [id]: event.target.checked }))} aria-label={`Установить ${names[id]}`} />
                    <span className={`setup-agent-logo setup-agent-${id}`}><AgentLogo provider={id} size={28} /></span>
                    <span className="setup-agent-copy"><strong>{names[id]}</strong><span>{id === 'codex' ? 'Агент OpenAI для ваших проектов' : 'Агент Anthropic для ваших проектов'}</span></span>
                    <span className={`setup-status${found ? ' is-good' : ''}`}>{found ? <><CircleCheck size={13} />Установлен</> : component?.status === 'error' ? 'Нужна проверка' : 'Не найден'}</span>
                  </label>
                  <div className="setup-agent-details"><span>{found ? component?.version || 'Готов к подключению' : selected[id] ? 'Будет установлен' : 'Можно добавить позже'}</span><button className="setup-text-button" disabled={busy} onClick={() => void chooseExecutable(id)}><FolderOpen size={13} />Указать путь</button></div>
                  {running && <div className="setup-install-progress" role="status"><LoaderCircle className="setup-spin" size={14} />{activeProgress.message}</div>}
                  {detail && <p className="setup-card-error" role="alert">{detail}</p>}
                </section>;
              })}</div>
              <div className="setup-scan-footer"><span>{scan.platformSupported ? 'Установка из официальных источников' : 'Автоматическая установка доступна в Windows'}</span><button className="setup-text-button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={13} />Проверить снова</button></div>
            </>}
          </>}

          {step === 1 && <section className="setup-auth-card" data-portal-session={session?.state || 'unknown'}>
            <div className="setup-auth-title"><span className="setup-feature-icon"><KeyRound size={25} /></span><div><strong>Portal</strong><span className={signedIn ? 'setup-auth-good' : ''}>{portalOperation === 'session' && !session ? 'Проверяем вход…' : signedIn ? 'Вход выполнен' : waitingForLogin ? 'Ожидаем вход' : 'Требуется вход'}</span></div>{portalOperation || loginPending ? <LoaderCircle className="setup-spin" size={19} /> : signedIn ? <CircleCheck className="setup-auth-good" size={21} /> : <KeyRound size={18} />}</div>

            {signedIn && session?.email && <p className="setup-auth-email">{session.email}</p>}
            {signedIn && session?.name && <p className="setup-small-note">{session.name}</p>}

            {waitingForLogin && <>
              <div className="setup-auth-waiting" role="status"><LoaderCircle className="setup-spin" size={15} /><span>Завершите вход в открывшемся окне. Результат появится здесь сам.</span></div>
              <div className="setup-inline-actions"><button className="setup-button" onClick={focusLogin}>Показать окно входа</button></div>
            </>}

            {!waitingForLogin && !signedIn && <>
              <p className="setup-auth-help">Вход нужен один раз: по нему Кузьмич сам получит настройки для установленных CLI. Окно входа открывается внутри приложения, и пароль в него не попадает.</p>
              <div className="setup-inline-actions"><button className="setup-button is-primary" disabled={busy} onClick={login}><LogIn size={14} />Войти в Portal</button></div>
            </>}

            {signedIn && <>
              <div className="setup-result-list" aria-label="Состояние ключа и доступов">
                <div className="setup-result-row" data-key-state={keyState}><KeyRound size={19} /><strong>Ключ роутера</strong><span className={keyState === 'approved' ? 'is-good' : ''}>{keyState ? keyLabels[keyState] : 'Проверяется'}</span></div>
                {providers.map(provider => <div className="setup-result-row" key={provider} data-product={provider}><AgentLogo provider={provider} size={19} /><strong>{names[provider]}</strong><span className={session?.products[provider] && installed(provider) ? 'is-good' : ''}>{session?.products[provider] ? 'Portal разрешает' : 'Portal не даёт доступ'} · {installed(provider) ? 'установлен' : 'не установлен'}</span></div>)}
              </div>
              {keyState === 'pending' && <>
                <p className="setup-auth-help">Пока ключ на паузе, подключить CLI не получится. Снимает паузу администратор портала.</p>
                <div className="setup-inline-actions"><button className="setup-button" disabled={busy} onClick={recheck}>{portalOperation === 'session' ? <LoaderCircle className="setup-spin" size={14} /> : <RefreshCw size={14} />}Проверить снова</button></div>
              </>}
              {keyState === 'none' && <>
                <p className="setup-auth-help">Ключ роутера выдаётся по вашей учётной записи Portal. Новый ключ может попасть на паузу до одобрения администратором портала.</p>
                <div className="setup-inline-actions"><button className="setup-button is-primary" disabled={busy} onClick={requestKey}>{portalOperation === 'request-key' ? <LoaderCircle className="setup-spin" size={14} /> : <KeyRound size={14} />}Получить ключ</button></div>
              </>}
              {keyState === 'held-elsewhere' && <p className="setup-card-error" role="alert">{session?.heldBy ? `Ключ роутера уже выдан на почту ${session.heldBy}. Войдите под ней — или напишите в поддержку роутера, если это не вы.` : 'Ключ роутера уже выдан на другую почту. Войдите под ней — или напишите в поддержку роутера, если это не вы.'}</p>}
              {keyState === 'approved' && !available.length && <p className="setup-auth-help">Ключ активен, но ни один CLI пока не установлен. Вернитесь к шагу «CLI».</p>}
              <div className="setup-inline-actions"><button className="setup-text-button" disabled={busy} onClick={logout}>{portalOperation === 'logout' ? <LoaderCircle className="setup-spin" size={13} /> : null}Выйти</button></div>
            </>}

            {session?.message && <p className={session.state === 'signed-in' ? 'setup-small-note' : 'setup-card-error'}>{session.message}</p>}
          </section>}

          {step === 1 && <div className="setup-footnote"><ShieldCheck size={16} /><p>Сессия Portal остаётся у {productOf} и наружу не передаётся. Подключение CLI к роутеру Кузьмич выполнит отдельным шагом.</p></div>}

          {step === 2 && <>
            {!keyApproved ? <div className="setup-empty-card" data-connect-gate={signedIn ? session?.keyState : 'signed-out'}>
              <KeyRound size={29} />
              <strong>{signedIn ? 'Сначала нужен активный ключ роутера' : 'Сначала нужен вход в Portal'}</strong>
              <p>{signedIn ? `${keyState ? keyLabels[keyState] : 'Ключ не проверен'}. Подключить CLI можно только с активным ключом — Portal иначе откажет.` : 'Настройки для CLI Кузьмич получает по вашей сессии Portal. Без входа подключать нечего.'}</p>
              <button className="setup-button" disabled={busy} onClick={() => setStep(1)}>К шагу «Вход»</button>
            </div> : !available.length ? <div className="setup-empty-card">
              <Terminal size={29} />
              <strong>Агенты пока не установлены</strong>
              <p>Подключать нечего: ни Codex CLI, ни Claude Code CLI не найдены. Вернитесь к шагу «CLI».</p>
              <button className="setup-button" disabled={busy} onClick={() => setStep(0)}>К выбору агентов</button>
            </div> : <>
              <div className="setup-agent-list">{available.map(provider => {
                const state = connectState(provider);
                return <section className={`setup-agent-card${state.state === 'done' ? ' is-selected' : ''}`} key={provider} data-connect={provider} data-connect-state={state.state}>
                  <div className="setup-auth-title">
                    <span className={`setup-agent-logo setup-agent-${provider}`}><AgentLogo provider={provider} size={25} /></span>
                    <div><strong>{names[provider]}</strong><span className={state.state === 'done' ? 'setup-auth-good' : ''}>{connectLabels[state.state]}</span></div>
                    {state.state === 'working' ? <LoaderCircle className="setup-spin" size={19} /> : state.state === 'done' ? <CircleCheck className="setup-auth-good" size={21} /> : state.state === 'error' ? <CircleAlert size={19} /> : <PlugZap size={18} />}
                  </div>
                  {state.state === 'working' && <div className="setup-install-progress" role="status"><LoaderCircle className="setup-spin" size={14} />{state.message || 'Записываем настройки…'}</div>}
                  {state.state === 'done' && <>
                    {state.message && <p className="setup-small-note">{state.message}</p>}
                    {state.configPath && <p className="setup-small-note">Файл настроек: <code>{state.configPath}</code></p>}
                    {state.backupPath && <p className="setup-small-note">Резервная копия прежнего файла: <code>{state.backupPath}</code></p>}
                  </>}
                  {state.state === 'skipped' && <p className="setup-small-note">{state.message || 'Этот агент пропущен.'}</p>}
                  {state.state === 'error' && <>
                    <p className="setup-card-error" role="alert">{state.message || 'Подключить не удалось. Попробуйте ещё раз.'}</p>
                    <div className="setup-inline-actions"><button className="setup-button" disabled={busy} onClick={() => startConnect([provider])}><RefreshCw size={14} />Повторить</button></div>
                  </>}
                  {state.state === 'idle' && <p className="setup-auth-help">Настройки запишутся в вашу обычную конфигурацию {provider === 'codex' ? 'Codex CLI' : 'Claude Code CLI'}; прежний файл уйдёт в резервную копию.</p>}
                </section>;
              })}</div>
              {!anyWorking && retryable && <div className="setup-inline-actions"><button className="setup-button is-primary" disabled={busy} onClick={() => startConnect()}>{connectPending ? <LoaderCircle className="setup-spin" size={15} /> : <PlugZap size={15} />}{connect ? 'Подключить снова' : 'Подключить'}</button></div>}
              {connectRunning && <div className="setup-auth-waiting" role="status"><LoaderCircle className="setup-spin" size={15} /><span>Кузьмич подключает CLI. Не закрывайте мастер до конца записи.</span></div>}
              {!connectRunning && connect && !retryable && <p className="setup-portal-confirmed"><CircleCheck size={15} />Подключение завершено</p>}
            </>}
            <div className="setup-footnote"><ShieldCheck size={16} /><p>Ключ роутера остаётся в настройках CLI, и Кузьмич его не показывает. Эти же настройки будут действовать в терминальных Codex и Claude Code.</p></div>
          </>}

          {step === 3 && <>
            <div className="setup-finish-mark"><CheckCheck size={32} /></div>
            <div className="setup-result-list">
              {providers.map(provider => <div className="setup-result-row" key={provider}><AgentLogo provider={provider} size={19} /><strong>{names[provider]}</strong><span className={installed(provider) ? 'is-good' : ''}>{installed(provider) ? 'Установлен' : 'Установка пропущена'}</span></div>)}
              <div className="setup-result-row"><LogIn size={19} /><strong>Вход в Portal</strong><span className={signedIn ? 'is-good' : ''}>{signedIn ? session?.email || 'Выполнен' : 'Не выполнен'}</span></div>
              <div className="setup-result-row"><KeyRound size={19} /><strong>Ключ роутера</strong><span className={keyState === 'approved' ? 'is-good' : ''}>{signedIn && keyState ? keyLabels[keyState] : 'Не проверен'}</span></div>
              {available.map(provider => {
                const state = connectState(provider);
                return <div className="setup-result-row" key={`connect-${provider}`} data-connect-summary={provider} data-connect-state={state.state}><PlugZap size={19} /><strong>Подключение {provider === 'codex' ? 'Codex' : 'Claude'}</strong><span className={state.state === 'done' ? 'is-good' : ''}>{connectLabels[state.state]}</span></div>;
              })}
            </div>
            {available.length > 0 && <fieldset className="setup-start-agent"><legend>{initial ? 'С каким агентом начнём?' : 'Агент для новых диалогов'}</legend><div>{available.map(provider => <label key={provider} className={preferred === provider ? 'is-selected' : ''}><input type="radio" name="kuzmich-agent" value={provider} checked={preferred === provider} disabled={busy} onChange={() => { setPreferred(provider); setProviderTouched(true); }} /><AgentLogo provider={provider} size={18} /><span>{provider === 'codex' ? 'Codex' : 'Claude'}</span></label>)}</div></fieldset>}
            <div className="setup-footnote"><Settings2 size={16} /><p>Настройки → Подключение → Открыть мастер: установка CLI и вход в Portal доступны в любой момент.</p></div>
          </>}
        </div>
        <footer className="setup-footer"><div>{step > 0 ? <button className="setup-button is-quiet" disabled={busy} onClick={() => setStep(step - 1)}><ArrowLeft size={15} />Назад</button> : <button className="setup-button is-quiet" disabled={busy} onClick={() => finish(true)}>Настроить позже</button>}</div><div className="setup-footer-actions">
          {step === 0 && pending.length > 0 && scan?.platformSupported && <button className="setup-text-button setup-skip-install" disabled={busy} onClick={next}>Без установки</button>}
          {step === 1 && !signedIn && <button className="setup-text-button" disabled={busy} onClick={next}>Войти позже</button>}
          {step === 2 && keyApproved && available.length > 0 && !connect && <button className="setup-text-button" disabled={busy} onClick={next}>Без подключения</button>}
          {step === 0 ? <button className="setup-button is-primary" disabled={busy || !scan} onClick={() => pending.length > 0 && scan?.platformSupported ? void installSelected() : next()}>{busy ? <LoaderCircle className="setup-spin" size={16} /> : pending.length > 0 && scan?.platformSupported ? <Download size={16} /> : null}{operation === 'install' ? 'Устанавливаем…' : pending.length > 0 && scan?.platformSupported ? 'Установить и продолжить' : 'Продолжить'}{!busy && <ArrowRight size={15} />}</button>
            : step === 3 ? <button className="setup-button is-primary" disabled={busy} onClick={() => finish(false)}>{operation === 'complete' ? <LoaderCircle className="setup-spin" size={16} /> : null}{available.length ? 'Начать работу' : `Открыть ${productOf}`}<ArrowRight size={15} /></button>
              : <button className="setup-button is-primary" disabled={busy || (step === 2 && anyWorking)} onClick={next}>Продолжить<ArrowRight size={15} /></button>}
        </div></footer>
      </div>
    </div>
  </div>;
}
