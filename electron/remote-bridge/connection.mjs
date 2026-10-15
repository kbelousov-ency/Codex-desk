import { CLOSE, ProtocolError, SUBPROTOCOL, encodeFrame, parseFrame } from './protocol.mjs';

/**
 * One outgoing WSS connection: framing, envelope checks and the liveness watchdog. It knows
 * nothing about pairing, snapshots or commands — the session logic drives it from `service.mjs`.
 *
 * The watchdog is application-level on purpose. The `WebSocket` client built into Node/Electron
 * gives no way to send a protocol-level ping, so a silent half-open socket would otherwise look
 * alive forever; the contract's JSON ping/pong is what actually proves the relay is still there.
 */
export class RelayConnection {
  constructor({ url, WebSocketImpl = globalThis.WebSocket, onFrame, onClosed, onOpen }) {
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.onFrame = onFrame;
    this.onClosed = onClosed;
    this.onOpen = onOpen;
    this.socket = null;
    this.watchdog = null;
    this.settled = false;
    this.opened = false;
  }

  open() {
    if (!this.WebSocketImpl) { this._finish(0, 'В этой версии приложения нет встроенного клиента WebSocket.'); return; }
    let socket;
    try { socket = new this.WebSocketImpl(this.url, [SUBPROTOCOL]); }
    catch { this._finish(0, 'Не удалось открыть соединение с сервером.'); return; }
    this.socket = socket;
    socket.addEventListener('open', () => { this.opened = true; try { this.onOpen?.(); } catch { /* isolated */ } });
    socket.addEventListener('message', event => this._receive(event));
    socket.addEventListener('error', () => { /* the close event carries the outcome */ });
    socket.addEventListener('close', event => this._finish(event?.code ?? 0, typeof event?.reason === 'string' ? event.reason : ''));
  }

  _receive(event) {
    if (this.settled) return;
    this._arm();
    let frame;
    try {
      if (typeof event.data !== 'string') throw new ProtocolError('Сервер прислал двоичный фрейм.');
      frame = parseFrame(event.data);
    } catch (cause) {
      this.close(cause instanceof ProtocolError ? cause.close : CLOSE.protocol, 'frame');
      return;
    }
    try { this.onFrame?.(frame); }
    catch (cause) { this.close(cause instanceof ProtocolError ? cause.close : CLOSE.protocol, 'handler'); }
  }

  /** Resets the liveness deadline. Any frame from the relay counts, not only `ping`. */
  _arm() {
    if (!this.deadlineMs) return;
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.close(CLOSE.normal, 'timeout'), this.deadlineMs);
    this.watchdog.unref?.();
  }

  /**
   * Called once the relay stated its heartbeat interval in `welcome`. The deadline is computed by
   * the caller (`livenessDeadlineMs`), so the rule lives in the protocol module next to the rest
   * of the contract's numbers rather than being buried in the socket.
   */
  armWatchdog(deadlineMs) {
    this.deadlineMs = deadlineMs;
    this._arm();
  }

  send(frame) {
    if (this.settled || this.socket?.readyState !== 1) return false;
    let text;
    try { text = encodeFrame(frame); } catch { return false; }
    try { this.socket.send(text); return true; }
    catch { return false; }
  }

  close(code = CLOSE.normal, reason = '') {
    if (this.settled) return;
    try { this.socket?.close(code, reason.slice(0, 120)); }
    catch { /* already gone */ }
    // A socket that never opened emits no close event in every implementation.
    if (this.socket?.readyState === 3 || !this.opened) this._finish(code, reason);
  }

  _finish(code, reason) {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.watchdog);
    this.watchdog = null;
    try { this.onClosed?.({ code, reason }); } catch { /* isolated */ }
  }
}
