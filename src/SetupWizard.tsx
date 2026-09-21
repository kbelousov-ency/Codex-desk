import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckCheck, CircleAlert, CircleCheck, Download, ExternalLink, FileCheck2, FileText, FolderOpen, GitBranch, KeyRound, LoaderCircle, RefreshCw, Settings2, ShieldCheck, Terminal, X } from 'lucide-react';
import AgentLogo from './AgentLogo';
import type { AgentProvider } from './types';
import type { SetupAuthStatus, SetupComponentId, SetupConfigPreview, SetupProgress, SetupScan } from './setup-types';
import './setup-wizard.css';

const steps = [
  { label: 'Агенты', detail: 'Выбор и установка', icon: Terminal },
  { label: 'Конфигурация', detail: 'Ваши настройки Codex', icon: FileText },
  { label: 'Вход в аккаунт', detail: 'Подключение агентов', icon: KeyRound },
  { label: 'Готово', detail: 'Можно начинать', icon: CheckCheck },
];
const names: Record<SetupComponentId, string> = { codex: 'Codex CLI', claude: 'Claude Code CLI', git: 'Git' };
const providers: AgentProvider[] = ['codex', 'claude'];
const authLabels: Record<SetupAuthStatus['state'], string> = {
  'signed-in': 'Вход выполнен', 'signed-out': 'Требуется вход', provider: 'Настроен провайдер', unknown: 'Вход не подтверждён',
};
const errorText = (cause: unknown) => cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Не удалось выполнить действие. Попробуйте ещё раз.';

export default function SetupWizard({ onClose, initial = false }: { onClose: (provider?: AgentProvider) => void; initial?: boolean }) {
  const bridge = window.codex.setup;
  const [step, setStep] = useState(0);
  const [scan, setScan] = useState<SetupScan | null>(null);
  const [selected, setSelected] = useState<Record<SetupComponentId, boolean>>({ codex: true, claude: true, git: false });
  const [operation, setOperation] = useState<string | null>('scan');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<Partial<Record<SetupComponentId, SetupProgress>>>({});
  const [installErrors, setInstallErrors] = useState<Partial<Record<SetupComponentId, string>>>({});
  const [preview, setPreview] = useState<SetupConfigPreview | null>(null);
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [appliedConfig, setAppliedConfig] = useState<{ configPath: string; backupPath: string | null } | null>(null);
  const [auth, setAuth] = useState<Partial<Record<AgentProvider, SetupAuthStatus>>>({});
  const [authChecking, setAuthChecking] = useState<AgentProvider[]>([]);
  const [authWaiting, setAuthWaiting] = useState<Partial<Record<AgentProvider, number>>>({});
  const [preferred, setPreferred] = useState<AgentProvider>('codex');
  const [providerTouched, setProviderTouched] = useState(false);
  const mounted = useRef(false);
  const operationLock = useRef(false);
  const authLocks = useRef(new Set<AgentProvider>());
  const dialog = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const configPreview = useRef<HTMLElement>(null);
  const dismiss = useRef(() => {});
  const busy = Boolean(operation) || authChecking.length > 0;
  const installed = (id: SetupComponentId) => scan?.components.some(component => component.id === id && component.status === 'installed') ?? false;
  const available = providers.filter(installed);
  const pending = (['codex', 'claude', 'git'] as SetupComponentId[]).filter(id => selected[id] && !installed(id));

  const run = useCallback(async (name: string, action: () => Promise<void>) => {
    if (operationLock.current || authLocks.current.size) return;
    operationLock.current = true;
    setOperation(name); setError('');
    try { await action(); }
    catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally {
      operationLock.current = false;
      if (mounted.current) setOperation(null);
    }
  }, []);

  const refresh = () => run('scan', async () => {
    if (!bridge) throw new Error('Мастер настройки доступен в установленном приложении Codex Desk.');
    const result = await bridge.scan();
    if (mounted.current) { setScan(result); setInstallErrors({}); setProgress({}); }
  });

  useEffect(() => {
    mounted.current = true;
    let active = true;
    operationLock.current = true;
    const unsubscribe = bridge?.onProgress(event => {
      if (active) setProgress(current => ({ ...current, [event.component]: event }));
    });
    if (bridge) {
      bridge.state().then(state => { if (active && state.preferredProvider) setPreferred(state.preferredProvider); }).catch(() => {});
      bridge.scan().then(result => {
        if (active) setScan(result);
      }).catch(cause => { if (active) setError(errorText(cause)); }).finally(() => {
        if (active) { operationLock.current = false; setOperation(null); }
      });
    } else { setOperation(null); operationLock.current = false; setError('Мастер настройки доступен в установленном приложении Codex Desk.'); }
    return () => { active = false; mounted.current = false; unsubscribe?.(); };
  }, [bridge]);

  const checkAuth = useCallback(async (provider: AgentProvider) => {
    if (!bridge || authLocks.current.has(provider) || operationLock.current) return;
    authLocks.current.add(provider);
    setAuthChecking(current => [...current, provider]);
    try {
      const result = await bridge.authStatus(provider);
      if (!mounted.current) return;
      setAuth(current => ({ ...current, [provider]: result }));
      if (result.state === 'signed-in' || result.state === 'provider') setAuthWaiting(current => ({ ...current, [provider]: undefined }));
    } catch (cause) {
      if (mounted.current) setAuth(current => ({ ...current, [provider]: { state: 'unknown', message: errorText(cause) } }));
    } finally {
      authLocks.current.delete(provider);
      if (mounted.current) setAuthChecking(current => current.filter(value => value !== provider));
    }
  }, [bridge]);

  // Opening this page checks installed CLIs only; no model request is sent.
  const availableKey = available.join(',');
  useEffect(() => {
    if (step !== 2) return;
    for (const provider of providers) if (availableKey.split(',').includes(provider)) void checkAuth(provider);
  }, [step, availableKey, checkAuth]);

  useEffect(() => {
    if (step !== 2 || !Object.values(authWaiting).some(Boolean)) return;
    const timer = window.setInterval(() => {
      for (const provider of providers) {
        const started = authWaiting[provider];
        if (!started) continue;
        if (Date.now() - started > 5 * 60_000) setAuthWaiting(current => ({ ...current, [provider]: undefined }));
        else void checkAuth(provider);
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [step, authWaiting, checkAuth]);

  const finish = (deferred = false) => {
    if (!bridge) { onClose(); return; }
    void run('complete', async () => {
      const provider = !deferred && (initial || providerTouched) && available.includes(preferred) ? preferred : undefined;
      await bridge.complete({ provider, deferred });
      if (mounted.current) onClose(provider);
    });
  };
  dismiss.current = () => { if (!busy) finish(true); };

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    title.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss.current(); }
      if (event.key !== 'Tab') return;
      const nodes = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]') || []).filter(node => node.getClientRects().length > 0);
      const first = nodes[0]; const last = nodes[nodes.length - 1];
      if (!first) { event.preventDefault(); title.current?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !nodes.includes(document.activeElement as HTMLElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !nodes.includes(document.activeElement as HTMLElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => { document.removeEventListener('keydown', handleKey, true); if (previous?.isConnected) previous.focus(); };
  }, []);

  useEffect(() => { title.current?.focus(); setError(''); }, [step]);
  useEffect(() => { if (preview) configPreview.current?.scrollIntoView({ block: 'nearest' }); }, [preview]);
  useEffect(() => {
    if (!availableKey.split(',').includes(preferred) && availableKey) setPreferred(availableKey.split(',')[0] as AgentProvider);
  }, [availableKey, preferred]);

  const next = () => { setStep(current => Math.min(current + 1, steps.length - 1)); };
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
  const chooseConfig = () => run('choose-config', async () => {
    const result = await bridge?.previewConfig();
    if (mounted.current && result) { setPreview(result); setReplaceExisting(false); setAppliedConfig(null); }
  });
  const applyConfig = (advance = false) => run('apply-config', async () => {
    if (!bridge || !preview || (preview.exists && !replaceExisting)) return;
    const result = await bridge.applyConfig({ previewId: preview.previewId, replaceExisting });
    if (mounted.current) {
      setAppliedConfig(result); setPreview(null);
      setScan(current => current ? { ...current, config: { ...current.config, exists: true } } : current);
      setAuth(current => ({ ...current, codex: undefined }));
      if (advance) next();
    }
  });
  const login = (provider: AgentProvider) => run(`login-${provider}`, async () => {
    await bridge?.login(provider);
    if (mounted.current) setAuthWaiting(current => ({ ...current, [provider]: Date.now() }));
  });

  const titles = ['Настроим ваше рабочее место', 'Настройки Codex — из вашего файла', 'Подключите свои аккаунты', available.length ? 'Всё для первого диалога' : 'Настройка сохранена'];
  const subtitles = [
    'Выберите агентов, с которыми хотите работать. Уже установленные программы подключатся автоматически.',
    'Загрузите конфигурацию с портала или используйте текущие настройки. Этот шаг можно пропустить.',
    'Войдите один раз, чтобы продолжить работу в Codex Desk. Можно завершить этот шаг позже.',
    'Ниже — результат настройки. К этому мастеру всегда можно вернуться из настроек приложения.',
  ];

  return <div className="setup-overlay">
    <div className="setup-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="setup-title" aria-describedby="setup-description" aria-busy={busy} data-step={step}>
      <aside className="setup-sidebar" aria-label="Этапы настройки">
        <div className="setup-brand"><span className="setup-brand-mark"><Terminal size={23} /></span><span>Codex <span>Desk</span></span></div>
        <div className="setup-sidebar-caption">ВАШЕ РАБОЧЕЕ МЕСТО</div>
        <ol className="setup-steps">{steps.map((item, index) => <li key={item.label} className={index === step ? 'is-current' : index < step ? 'is-complete' : ''} aria-current={index === step ? 'step' : undefined}>
          <span className="setup-step-symbol">{index < step ? <Check size={17} /> : <item.icon size={17} />}</span><span><strong>{item.label}</strong><small>{item.detail}</small></span>
        </li>)}</ol>
        <div className="setup-sidebar-note"><ShieldCheck size={19} /><p>Ваши агенты.<br />Привычные возможности.<br />В одном приложении.</p></div>
        <span className="setup-sidebar-bottom">НАСТРОЙКА CODEX DESK</span>
      </aside>
      <div className="setup-main">
        <header className="setup-header"><span>ШАГ {step + 1} ИЗ {steps.length}</span><button className="setup-icon-button" aria-label={initial ? 'Настроить позже' : 'Закрыть мастер настройки'} disabled={busy} onClick={() => finish(true)}><X size={18} /></button></header>
        <div className="setup-body">
          <h1 id="setup-title" ref={title} tabIndex={-1}>{titles[step]}</h1>
          <p id="setup-description" className="setup-description">{subtitles[step]}</p>
          {error && <div className="setup-alert is-error" role="alert"><CircleAlert size={17} /><span>{error}</span></div>}

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
              <section className="setup-git-card" data-component="git"><div className="setup-git-top"><label><input type="checkbox" aria-label="Установить Git" checked={installed('git') || selected.git} disabled={busy || installed('git') || !scan.platformSupported} onChange={event => setSelected(current => ({ ...current, git: event.target.checked }))} /><GitBranch size={19} /><strong>Git</strong><span className="setup-optional">дополнительно</span></label><span className={`setup-status${installed('git') ? ' is-good' : ''}`}>{installed('git') ? <><CircleCheck size={13} />Установлен</> : 'Не найден'}</span></div>
                <p>История изменений, ветки и параллельные задачи в отдельных рабочих копиях.</p>
                {operation === 'install' && progress.git && ['installing', 'checking'].includes(progress.git.stage) && <div className="setup-install-progress" role="status"><LoaderCircle className="setup-spin" size={14} />{progress.git.message}</div>}
                {installErrors.git && <p className="setup-card-error" role="alert">{installErrors.git}</p>}
                {!installed('git') && <button className="setup-text-button" disabled={busy} onClick={() => void run('git-website', async () => { await bridge?.openGitWebsite(); })}>Скачать с сайта Git<ExternalLink size={12} /></button>}
              </section>
              <div className="setup-scan-footer"><span>{scan.platformSupported ? 'Установка из официальных источников' : 'Автоматическая установка доступна в Windows'}</span><button className="setup-text-button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={13} />Проверить снова</button></div>
            </>}
          </>}

          {step === 1 && <>
            {!installed('codex') ? <div className="setup-empty-card"><FileText size={29} /><strong>Сначала установите Codex CLI</strong><p>После установки вы сможете выбрать файл конфигурации. Можно вернуться к выбору агентов или продолжить настройку Claude.</p><button className="setup-button" onClick={() => setStep(0)}>К выбору агентов</button></div> : <>
              <div className="setup-portal-card"><span className="setup-feature-icon"><FileText size={25} /></span><div><strong>Конфигурация с портала</strong><p>Файл конфигурации можно скачать на сайте <button className="setup-inline-link" disabled={busy} onClick={() => void run('portal', async () => { await bridge?.openPortal(); })}>coder-portal.encycam.com</button>.</p><button className="setup-button" disabled={busy} onClick={() => void run('portal', async () => { await bridge?.openPortal(); })}>Открыть портал<ExternalLink size={14} /></button></div></div>
              {appliedConfig ? <div className="setup-applied" role="status"><CircleCheck size={22} /><div><strong>Конфигурация применена</strong><code>{appliedConfig.configPath}</code>{appliedConfig.backupPath && <p>Резервная копия прежнего файла:<code>{appliedConfig.backupPath}</code></p>}</div></div> : <div className="setup-config-destination"><span>{scan?.config.exists ? 'Найдена текущая конфигурация' : 'Конфигурация будет сохранена в'}</span><code>{preview?.targetPath || scan?.config.targetPath}</code></div>}
              {(preview?.customHome ?? scan?.config.customHome) && <div className="setup-alert"><CircleAlert size={17} /><span>У вас задан отдельный каталог Codex (CODEX_HOME). Файл будет применён по действующему пути выше. Стандартный путь:<code>{preview?.defaultPath || scan?.config.defaultPath}</code></span></div>}
              {preview && <section className="setup-config-preview" ref={configPreview}><div className="setup-preview-file"><FileCheck2 size={22} /><div><strong>{preview.filename}</strong><span>Файл проверен и готов к применению</span></div></div>{preview.exists && <label className="setup-replace-label"><input type="checkbox" checked={replaceExisting} disabled={busy} onChange={event => setReplaceExisting(event.target.checked)} /><span>Заменить текущую конфигурацию с резервной копией</span></label>}<p>Эти настройки будут использоваться также в терминальном Codex. Модель, провайдер и подключения будут взяты из выбранного файла.</p><div className="setup-inline-actions"><button className="setup-button is-primary" disabled={busy || (preview.exists && !replaceExisting)} onClick={() => void applyConfig()}>{operation === 'apply-config' ? <LoaderCircle className="setup-spin" size={15} /> : <Check size={15} />}Применить файл</button><button className="setup-text-button" disabled={busy} onClick={() => { setPreview(null); setReplaceExisting(false); }}>Отменить выбор</button></div></section>}
              <button className="setup-button setup-choose-file" disabled={busy} onClick={() => void chooseConfig()}><FolderOpen size={16} />{preview || appliedConfig ? 'Выбрать другой файл…' : 'Выбрать файл…'}</button>
              {!preview && !appliedConfig && <p className="setup-small-note">Выберите скачанный файл TOML. Текущий файл заменяется только после вашего подтверждения.</p>}
            </>}
          </>}

          {step === 2 && <>
            {!available.length ? <div className="setup-empty-card"><KeyRound size={29} /><strong>Агенты пока не установлены</strong><p>Вход станет доступен после установки Codex CLI или Claude Code CLI.</p><button className="setup-button" onClick={() => setStep(0)}>К выбору агентов</button></div> : <div className="setup-auth-list">{available.map(provider => {
              const status = auth[provider]; const checking = authChecking.includes(provider); const waiting = Boolean(authWaiting[provider]);
              const signedIn = status?.state === 'signed-in'; const configuredProvider = status?.state === 'provider';
              return <section className="setup-auth-card" key={provider} data-auth={provider}>
                <div className="setup-auth-title"><span className={`setup-agent-logo setup-agent-${provider}`}><AgentLogo provider={provider} size={25} /></span><div><strong>{names[provider]}</strong><span className={signedIn || configuredProvider ? 'setup-auth-good' : ''}>{checking ? 'Проверяем вход…' : status ? authLabels[status.state] : 'Проверка входа'}</span></div>{checking ? <LoaderCircle className="setup-spin" size={19} /> : signedIn || configuredProvider ? <CircleCheck className="setup-auth-good" size={21} /> : <KeyRound size={18} />}</div>
                {status?.email && <p className="setup-auth-email">{status.email}</p>}
                {status?.message && <p className={status.state === 'unknown' ? 'setup-card-error' : 'setup-small-note'}>{status.message}</p>}
                {!signedIn && !configuredProvider && !waiting && <p className="setup-auth-help">{provider === 'claude' ? 'Войдите в Claude через браузер. Если вход уже выполнен в CLI, он будет использован здесь.' : 'Войдите в Codex через браузер. Для подключения через провайдера используйте его конфигурацию.'}</p>}
                {waiting && <div className="setup-auth-waiting" role="status"><LoaderCircle className="setup-spin" size={15} /><span>Завершите вход в открывшемся окне. Результат проверится автоматически.</span></div>}
                <div className="setup-inline-actions">{!signedIn && !configuredProvider && <button className="setup-button" disabled={busy || waiting} onClick={() => void login(provider)}><ExternalLink size={14} />{waiting ? 'Ожидаем вход' : provider === 'claude' ? 'Войти в Claude' : 'Войти в Codex'}</button>}<button className="setup-text-button" disabled={busy} onClick={() => void checkAuth(provider)}><RefreshCw size={13} />Проверить вход</button>{waiting && <button className="setup-text-button" disabled={busy} onClick={() => setAuthWaiting(current => ({ ...current, [provider]: undefined }))}>Не ждать</button>}</div>
              </section>;
            })}</div>}
            <div className="setup-footnote"><ShieldCheck size={16} /><p>Вход выполняется средствами самого агента. Codex Desk использует уже сохранённую авторизацию.</p></div>
          </>}

          {step === 3 && <>
            <div className="setup-finish-mark"><CheckCheck size={32} /></div>
            <div className="setup-result-list">{providers.map(provider => <div className="setup-result-row" key={provider}><AgentLogo provider={provider} size={19} /><strong>{names[provider]}</strong><span className={installed(provider) ? 'is-good' : ''}>{installed(provider) ? auth[provider] ? authLabels[auth[provider]!.state] : 'Установлен' : 'Установка пропущена'}</span></div>)}<div className="setup-result-row"><FileText size={19} /><strong>Конфигурация Codex</strong><span>{appliedConfig ? 'Применена из файла' : scan?.config.exists ? 'Сохранена текущая' : 'Не добавлена'}</span></div><div className="setup-result-row"><GitBranch size={19} /><strong>Git</strong><span className={installed('git') ? 'is-good' : ''}>{installed('git') ? 'Установлен' : 'Можно добавить позже'}</span></div></div>
            {available.length > 0 && <fieldset className="setup-start-agent"><legend>{initial ? 'С каким агентом начнём?' : 'Агент для новых диалогов'}</legend><div>{available.map(provider => <label key={provider} className={preferred === provider ? 'is-selected' : ''}><input type="radio" name="setup-agent" value={provider} checked={preferred === provider} disabled={busy} onChange={() => { setPreferred(provider); setProviderTouched(true); }} /><AgentLogo provider={provider} size={18} /><span>{provider === 'codex' ? 'Codex' : 'Claude'}</span></label>)}</div></fieldset>}
            <div className="setup-footnote"><Settings2 size={16} /><p>Настройки → Настройка агентов: установка CLI, импорт конфигурации и вход доступны в любой момент.</p></div>
          </>}
        </div>
        <footer className="setup-footer"><div>{step > 0 ? <button className="setup-button is-quiet" disabled={busy} onClick={() => setStep(current => current - 1)}><ArrowLeft size={15} />Назад</button> : <button className="setup-button is-quiet" disabled={busy} onClick={() => finish(true)}>Настроить позже</button>}</div><div className="setup-footer-actions">
          {step === 0 && pending.length > 0 && scan?.platformSupported && <button className="setup-text-button setup-skip-install" disabled={busy} onClick={next}>Без установки</button>}
          {step === 1 && preview && <button className="setup-text-button" disabled={busy} onClick={next}>Пропустить</button>}
          {step === 0 ? <button className="setup-button is-primary" disabled={busy || !scan} onClick={() => pending.length > 0 && scan?.platformSupported ? void installSelected() : next()}>{busy ? <LoaderCircle className="setup-spin" size={16} /> : pending.length > 0 && scan?.platformSupported ? <Download size={16} /> : null}{operation === 'install' ? 'Устанавливаем…' : pending.length > 0 && scan?.platformSupported ? 'Установить и продолжить' : 'Продолжить'}{!busy && <ArrowRight size={15} />}</button> : step === 3 ? <button className="setup-button is-primary" disabled={busy} onClick={() => finish(false)}>{operation === 'complete' ? <LoaderCircle className="setup-spin" size={16} /> : null}{available.length ? 'Начать работу' : 'Открыть Codex Desk'}<ArrowRight size={15} /></button> : step === 1 && preview ? <button className="setup-button is-primary" disabled={busy || (preview.exists && !replaceExisting)} onClick={() => void applyConfig(true)}>{operation === 'apply-config' ? <LoaderCircle className="setup-spin" size={16} /> : null}Применить и продолжить<ArrowRight size={15} /></button> : <button className="setup-button is-primary" disabled={busy} onClick={next}>{step === 1 && !appliedConfig ? scan?.config.exists && installed('codex') ? 'Оставить текущую' : 'Пропустить' : step === 2 && available.some(provider => auth[provider]?.state !== 'signed-in' && auth[provider]?.state !== 'provider') ? 'Войти позже' : 'Продолжить'}<ArrowRight size={15} /></button>}
        </div></footer>
      </div>
    </div>
  </div>;
}
