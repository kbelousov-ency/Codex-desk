import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

/**
 * A stand-in relay: a real WebSocket server the bridge connects to over a real socket.
 *
 * Node ships a WebSocket *client* but no server, and this repository adds no dependencies, so the
 * server half of RFC 6455 lives here — handshake, masked client frames, unmasked server frames,
 * close and ping. That is deliberate: driving the production bridge through an actual socket is
 * what makes the connection, reconnect and heartbeat tests mean anything.
 */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encode(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) { header = Buffer.alloc(2); header[1] = length; }
  else if (length < 65_536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(length, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(length), 2); }
  header[0] = 0x80 | opcode;   // every server frame here is final and unfragmented
  return Buffer.concat([header, payload]);
}

class RelaySocket extends EventEmitter {
  constructor(raw, protocol) {
    super();
    this.raw = raw;
    this.protocol = protocol;
    this.frames = [];
    this.closed = false;
    this.closeCode = null;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    raw.on('data', chunk => this._read(chunk));
    raw.on('close', () => { this.closed = true; this.emit('closed'); });
    raw.on('error', () => { this.closed = true; });
  }

  _read(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const buffer = this.buffer;
      if (buffer.length < 2) return;
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      const maskAt = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      let payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (masked) {
        const mask = buffer.subarray(maskAt, maskAt + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      this.buffer = buffer.subarray(offset + length);
      this._frame(fin, opcode, payload);
    }
  }

  _frame(fin, opcode, payload) {
    if (opcode === 0x8) {
      this.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      this.emit('clientClose', this.closeCode);
      try { this.raw.write(encode(0x8, payload.subarray(0, 2))); } catch { /* already gone */ }
      this.raw.end();
      return;
    }
    if (opcode === 0x9) { try { this.raw.write(encode(0xa, payload)); } catch { /* ignore */ } return; }
    if (opcode === 0xa) return;
    if (opcode === 0x0) { this.fragments.push(payload); }
    else { this.fragments = [payload]; this.textFrame = opcode === 0x1; }
    if (!fin) return;
    const body = Buffer.concat(this.fragments).toString('utf8');
    this.fragments = [];
    let frame = null;
    try { frame = JSON.parse(body); } catch { /* the test asserts on the raw text instead */ }
    const record = { raw: body, frame };
    this.frames.push(record);
    this.emit('frame', frame, record);
  }

  /** Server frames are never masked, per the protocol. */
  send(value) {
    if (this.closed) return;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    this.raw.write(encode(0x1, Buffer.from(text, 'utf8')));
  }

  sendBinary(payload = Buffer.from([1])) { if (!this.closed) this.raw.write(encode(0x2, payload)); }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    try { this.raw.write(encode(0x8, body)); } catch { /* ignore */ }
    this.raw.end();
  }

  /** Drops the TCP connection without a close frame — what a lost network looks like. */
  destroy() { this.raw.destroy(); }

  /** Waits for the next frame of a kind, including ones already received. */
  next(type, { timeoutMs = 5000 } = {}) {
    const found = this.frames.find(entry => entry.frame?.type === type && !entry.consumed);
    if (found) { found.consumed = true; return Promise.resolve(found.frame); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.off('frame', listener); reject(new Error(`Фрейм ${type} не пришёл за ${timeoutMs} мс`)); }, timeoutMs);
      const listener = (frame, record) => {
        if (frame?.type !== type) return;
        record.consumed = true;
        clearTimeout(timer);
        this.off('frame', listener);
        resolve(frame);
      };
      this.on('frame', listener);
    });
  }

  sent(type) { return this.frames.filter(entry => entry.frame?.type === type).map(entry => entry.frame); }
}

export async function startRelay({ onSocket } = {}) {
  const server = createServer((_request, response) => { response.writeHead(426); response.end(); });
  const sockets = [];
  const emitter = new EventEmitter();
  let rejectUpgrade = false;

  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key'];
    if (rejectUpgrade || !key) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    const offered = String(request.headers['sec-websocket-protocol'] || '').split(',').map(value => value.trim()).filter(Boolean);
    const lines = [
      'HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
    ];
    if (offered.length) lines.push(`Sec-WebSocket-Protocol: ${offered[0]}`);
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    const wrapped = new RelaySocket(socket, offered[0] ?? null);
    wrapped.url = request.url;
    wrapped.requestHeaders = request.headers;
    sockets.push(wrapped);
    emitter.emit('socket', wrapped);
    try { onSocket?.(wrapped); } catch { /* the test asserts on the socket instead */ }
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `ws://127.0.0.1:${port}`,
    port,
    sockets,
    get last() { return sockets[sockets.length - 1]; },
    set reject(value) { rejectUpgrade = value; },
    /** Waits for the Nth connection (1-based), including ones already made. */
    waitForSocket(index = sockets.length + 1, { timeoutMs = 5000 } = {}) {
      if (sockets.length >= index) return Promise.resolve(sockets[index - 1]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { emitter.off('socket', listener); reject(new Error(`Соединение ${index} не установлено за ${timeoutMs} мс`)); }, timeoutMs);
        const listener = () => {
          if (sockets.length < index) return;
          clearTimeout(timer);
          emitter.off('socket', listener);
          resolve(sockets[index - 1]);
        };
        emitter.on('socket', listener);
      });
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
