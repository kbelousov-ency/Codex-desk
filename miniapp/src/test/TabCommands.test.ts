import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelayApi, RelayApiError } from '../api';
import { TabCommands, type TabCommandsProps } from '../TabCommands';
import type { CommandResponse, CommandSummary, SendCommandInput, TabSummary } from '../types';

const NOW = '2026-10-14T10:00:00.000Z';
const INSTALLATION = '123e4567-e89b-42d3-a456-426614174000';
const TAB: TabSummary = { tab_id: 't_fixture', name: 'Fixture tab', agent: 'codex', project: 'Fixture',
  status: 'idle', queueLength: 0, queuePaused: false, updatedAt: NOW };
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}
function summary(input: SendCommandInput, status: CommandSummary['status'] = null,
  outcome: CommandSummary['outcome'] = null): CommandSummary {
  return { commandId: input.commandId, tabId: input.tabId, action: input.action, status, outcome,
    dispatchState: 'sent', detail: null, createdAt: NOW, updatedAt: new Date().toISOString() };
}
function answerResponse(input: SendCommandInput, text: string): CommandResponse {
  return { command: summary(input, 'executed', 'succeeded'), payload: { answer: {
    answerId: 'answer_fixture', turnId: 'turn_fixture', text, truncated: false, completedAt: NOW
  } } };
}
function stateResponse(input: SendCommandInput): CommandResponse {
  return { command: summary(input, 'executed', 'succeeded'), payload: { state: {
    tabId: TAB.tab_id, title: TAB.name, agent: 'codex', project: TAB.project, status: 'blocked',
    queueLength: 0, queuePaused: true, updatedAt: NOW, activeTurnId: 'turn-exact-A', actions: { send: false, stop: true }
  } } };
}

describe('TabCommands DOM behavior', () => {
  let container: HTMLDivElement;
  let root: Root | undefined;
  let originalActFlag: boolean | undefined;
  let props: TabCommandsProps;
  let sendCommand: ReturnType<typeof vi.fn<RelayApi['sendCommand']>>;
  let getCommand: ReturnType<typeof vi.fn<RelayApi['getCommand']>>;
  let commandListeners: Set<(installationId: string, command: CommandSummary) => void>;

  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(NOW));
    originalActFlag = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    sendCommand = vi.fn<RelayApi['sendCommand']>().mockImplementation(async (_installation, input) => ({ command: summary(input) }));
    getCommand = vi.fn<RelayApi['getCommand']>().mockImplementation(async (_installation, id) =>
      summary({ commandId: id, tabId: TAB.tab_id, action: 'send' }, 'executed', 'succeeded'));
    commandListeners = new Set();
    const subscribeCommands = (listener: (installationId: string, command: CommandSummary) => void) => {
      commandListeners.add(listener); return () => { commandListeners.delete(listener); };
    };
    props = { api: { sendCommand, getCommand, subscribeCommands } as unknown as RelayApi, installationId: INSTALLATION,
      tab: { ...TAB }, installationOnline: true };
  });
  afterEach(async () => {
    if (root) await act(async () => { root!.unmount(); });
    root = undefined; container.remove(); vi.useRealTimers(); vi.restoreAllMocks();
    if (originalActFlag === undefined) delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    else actEnvironment.IS_REACT_ACT_ENVIRONMENT = originalActFlag;
  });
  async function render(overrides: Partial<TabCommandsProps> = {}) {
    props = { ...props, ...overrides };
    await act(async () => { root!.render(createElement(TabCommands, props)); });
  }
  function button(label: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll('button')).find(item => item.textContent?.trim() === label);
    expect(found, `button ${label}`).toBeDefined(); return found!;
  }
  async function click(label: string) {
    await act(async () => { button(label).click(); });
  }
  it.each(['running', 'blocked'] as const)('explains disabled send for a %s tab until it becomes idle', async status => {
    await render(); await enterText();
    await render({ tab: { ...TAB, status } });
    expect(button('Отправить').disabled).toBe(true);
    const hintId = button('Отправить').getAttribute('aria-describedby');
    expect(document.getElementById(hintId!)?.textContent).toBe('Беседа занята. Отправка станет доступна, когда задача закончится.');
    await click('Отправить');
    expect(sendCommand).not.toHaveBeenCalled();
    await render({ tab: { ...TAB } });
    expect(button('Отправить').disabled).toBe(false);
    expect(container.textContent).not.toContain('Беседа занята.');
    expect(button('Отправить').hasAttribute('aria-describedby')).toBe(false);
  });

  async function enterText(value = 'Fixture prompt') {
    const textarea = container.querySelector('textarea'); expect(textarea).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(textarea, value);
      textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button('Отправить').disabled).toBe(false);
  }

  it('polls a null receipt after four seconds, keeps GET single-flight and never POSTs it again', async () => {
    const poll = deferred<CommandSummary>(); getCommand.mockReturnValue(poll.promise);
    await render(); await enterText(); await click('Отправить');
    const input = sendCommand.mock.calls[0][1]; expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.command-status')?.textContent).toContain(input.commandId);
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(getCommand).toHaveBeenCalledTimes(1);
    expect(getCommand.mock.calls[0].slice(0, 2)).toEqual([INSTALLATION, input.commandId]);
    await act(async () => { await vi.advanceTimersByTimeAsync(12000); });
    expect(getCommand).toHaveBeenCalledTimes(1);
    await act(async () => { poll.resolve(summary(input, 'executed', 'succeeded')); });
    expect(container.querySelector('.command-status')?.className).toContain('status-executed');
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(getCommand).toHaveBeenCalledTimes(1); expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it('retains the generated ID after a network rejection and checks that same ID with GET', async () => {
    sendCommand.mockRejectedValue(new TypeError('Fixture network failure'));
    await render(); await enterText(); await click('Отправить');
    expect(sendCommand).toHaveBeenCalledTimes(1); const input = sendCommand.mock.calls[0][1];
    expect(input.commandId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(container.querySelector('.command-status')?.textContent).toContain(input.commandId);
    const refresh = container.querySelector<HTMLButtonElement>('.command-status button'); expect(refresh).not.toBeNull();
    await act(async () => { refresh!.click(); });
    expect(getCommand.mock.calls[0].slice(0, 2)).toEqual([INSTALLATION, input.commandId]);
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it('accepts the first real ACK even when the relay clock is behind the phone clock', async () => {
    sendCommand.mockImplementation(async (_installation, input) => ({ command: { ...summary(input, 'accepted'),
      createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' } }));
    await render(); await enterText(); await click('Отправить');
    expect(container.querySelector('.command-status')?.className).toContain('status-accepted');
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it('shows unavailable recovery without changing wire status or resubmitting the command', async () => {
    sendCommand.mockImplementation(async (_installation, input) => ({ command: {
      ...summary(input, 'queued'), replayUnavailable: 'legacy_payload_missing'
    } }));
    await render(); await enterText(); await click('Отправить');
    const input = sendCommand.mock.calls[0][1];
    const status = container.querySelector('.command-status');
    expect(status?.className).toContain('status-queued');
    expect(status?.textContent).toContain('Не удалось восстановить доставку');
    expect(Array.from(status!.querySelectorAll('button')).map(button => button.textContent)).toEqual(['Проверить этот ID']);
    await act(async () => {
      for (const listener of commandListeners) listener(INSTALLATION, summary(input, 'executed', 'succeeded'));
    });
    expect(container.querySelector('.command-status')?.className).toContain('status-executed');
    expect(container.textContent).not.toContain('Не удалось восстановить доставку');
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it('does not replace a newer WebSocket terminal status with a delayed status GET response', async () => {
    const poll = deferred<CommandSummary>(); getCommand.mockReturnValue(poll.promise);
    await render(); await enterText(); await click('Отправить');
    const input = sendCommand.mock.calls[0][1];
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(getCommand).toHaveBeenCalledTimes(1);
    await act(async () => {
      for (const listener of commandListeners) listener(INSTALLATION, summary(input, 'executed', 'succeeded'));
    });
    expect(container.querySelector('.command-status')?.className).toContain('status-executed');
    await act(async () => { poll.resolve({ ...summary(input, 'queued'), updatedAt: '2099-01-01T00:00:00.000Z' }); });
    expect(container.querySelector('.command-status')?.className).toContain('status-executed');
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it('aborts a pending answer when offline and discards its late payload even after reconnection', async () => {
    const pending = deferred<CommandResponse>(); sendCommand.mockReturnValue(pending.promise);
    await render(); await click('Последний ответ');
    const call = sendCommand.mock.calls[0], signal = call[2]; expect(signal).toBeDefined(); expect(signal!.aborted).toBe(false);
    await render({ installationOnline: false }); expect(signal!.aborted).toBe(true);
    await render({ installationOnline: true });
    await act(async () => { pending.resolve(answerResponse(call[1], 'LATE_PRIVATE_ANSWER')); });
    expect(container.textContent).not.toContain('LATE_PRIVATE_ANSWER'); expect(container.querySelector('.last-answer')).toBeNull();
  });

  it('aborts a pending answer on unmount and does not render its late response', async () => {
    const pending = deferred<CommandResponse>(); sendCommand.mockReturnValue(pending.promise);
    await render(); await click('Последний ответ'); const call = sendCommand.mock.calls[0];
    expect(call[2]).toBeDefined();
    await act(async () => { root!.unmount(); root = undefined; });
    expect(call[2]!.aborted).toBe(true);
    await act(async () => { pending.resolve(answerResponse(call[1], 'UNMOUNTED_PRIVATE_ANSWER')); });
    expect(container.textContent).toBe('');
  });

  it.each(['offline', 'expired session'] as const)('clears an already displayed answer on %s', async reason => {
    sendCommand.mockImplementation(async (_installation, input) => answerResponse(input, 'VISIBLE_PRIVATE_ANSWER'));
    await render(); await click('Последний ответ'); expect(container.textContent).toContain('VISIBLE_PRIVATE_ANSWER');
    await render(reason === 'offline' ? { installationOnline: false } :
      { serverError: new RelayApiError({ code: 'session_expired', message: 'session_expired', status: 401 }) });
    expect(container.textContent).not.toContain('VISIBLE_PRIVATE_ANSWER'); expect(container.querySelector('.last-answer')).toBeNull();
  });

  it('two synchronous send clicks produce one POST with one immutable ID', async () => {
    const pending = deferred<CommandResponse>(); sendCommand.mockReturnValue(pending.promise);
    await render(); await enterText('One deliberate message'); const send = button('Отправить');
    await act(async () => { send.click(); send.click(); });
    expect(sendCommand).toHaveBeenCalledTimes(1);
    const input = sendCommand.mock.calls[0][1]; expect(input.text).toBe('One deliberate message');
    await act(async () => { pending.resolve({ command: summary(input, 'accepted') }); });
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it('requires successful fresh state and an explicit confirmation before stopping the exact turn of a blocked tab', async () => {
    sendCommand.mockImplementation(async (_installation, input) => input.action === 'get_state' ? stateResponse(input) :
      { command: summary(input, 'executed', 'interrupted') });
    await render({ tab: { ...TAB, status: 'blocked' } });
    await click('Остановить');
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand.mock.calls[0][1].action).toBe('get_state');
    expect(button('Подтвердить остановку').disabled).toBe(false);
    expect(container.querySelector('.stop-confirm')?.textContent).toContain('turn-exact-A');
    await click('Подтвердить остановку');
    expect(sendCommand).toHaveBeenCalledTimes(2);
    expect(sendCommand.mock.calls[1][1]).toMatchObject({ tabId: TAB.tab_id, action: 'stop', expectedTurnId: 'turn-exact-A' });
    expect(sendCommand.mock.calls[1][1]).not.toHaveProperty('text');
    expect(sendCommand.mock.calls[1][1].commandId).not.toBe(sendCommand.mock.calls[0][1].commandId);
    expect(container.querySelector('.stop-confirm')).toBeNull();
    expect(container.querySelector('.command-status')?.className).toContain('status-executed');
  });

  it.each(['rejected', 'failed', 'wrong tab', 'stop disallowed', 'no active turn'] as const)
    ('does not offer stop confirmation when fresh state is %s', async condition => {
      sendCommand.mockImplementation(async (_installation, input) => {
        const response = stateResponse(input);
        const state = (response.payload as { state: Record<string, unknown> }).state;
        if (condition === 'rejected') response.command = summary(input, 'rejected');
        if (condition === 'failed') response.command = summary(input, 'executed', 'failed');
        if (condition === 'wrong tab') state.tabId = 't_someone_else';
        if (condition === 'stop disallowed') state.actions = { send: false, stop: false };
        if (condition === 'no active turn') state.activeTurnId = null;
        return response;
      });
      await render({ tab: { ...TAB, status: 'blocked' } }); await click('Остановить');
      expect(container.querySelector('.stop-confirm')).toBeNull();
      expect(sendCommand).toHaveBeenCalledTimes(1);
      expect(sendCommand.mock.calls[0][1].action).toBe('get_state');
    });

  it('treats answer:null as a successful empty answer, not a transport failure', async () => {
    sendCommand.mockImplementation(async (_installation, input) => ({
      command: summary(input, 'executed', 'succeeded'), payload: { answer: null }
    }));
    await render(); await click('Последний ответ');
    expect(container.querySelector('.last-answer')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain('не вернул');
    expect(container.querySelector('.command-status')?.className).toContain('status-executed');
  });

  it.each(['rejected', 'executed'] as const)('never renders answer content from unsuccessful %s result', async status => {
    sendCommand.mockImplementation(async (_installation, input) => ({ ...answerResponse(input, 'UNAUTHORIZED_ANSWER_PAYLOAD'),
      command: summary(input, status, status === 'executed' ? 'failed' : null)
    }));
    await render(); await click('Последний ответ');
    expect(container.textContent).not.toContain('UNAUTHORIZED_ANSWER_PAYLOAD');
    expect(container.querySelector('.last-answer')).toBeNull();
    expect(container.querySelector('.command-status')?.className).toContain(`status-${status}`);
  });
});
