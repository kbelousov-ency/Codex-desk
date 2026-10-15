import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { fail } from './security.ts';

export interface PayloadContext {
  installation_id: string; telegram_id: string; command_id: string; user_ref: string; fingerprint: string;
}
export interface SealedPayload { payload_ciphertext: string; payload_nonce: string; payload_tag: string }

function aad(context: PayloadContext): Buffer {
  return Buffer.from(JSON.stringify(['kuzmich-command-payload-v1', context.telegram_id, context.installation_id,
    context.command_id, context.user_ref, context.fingerprint]), 'utf8');
}
function decode(value: string, bytes?: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 512 * 1024) throw new Error('payload_corrupt');
  const buffer = Buffer.from(value, 'base64url');
  if (buffer.toString('base64url') !== value || (bytes !== undefined && buffer.length !== bytes)) throw new Error('payload_corrupt');
  return buffer;
}

/** Durable request ciphertext only; this class never receives a bridge response/read payload. */
export class CommandPayloadVault {
  private key?: Buffer;
  constructor(db: DatabaseSync, key?: string) {
    db.exec('CREATE TABLE IF NOT EXISTS command_payload_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), key_id TEXT NOT NULL)');
    if (!key) return;
    try { this.key = decode(key, 32); } catch { fail(503, 'command_payload_key_invalid'); }
    const keyId = createHash('sha256').update(this.key).digest('hex');
    const previous = db.prepare('SELECT key_id FROM command_payload_meta WHERE singleton=1').get()?.key_id;
    if (previous !== undefined && previous !== keyId) { this.key.fill(0); this.key = undefined; fail(503, 'command_payload_key_mismatch'); }
    db.prepare('INSERT OR IGNORE INTO command_payload_meta(singleton,key_id) VALUES (1,?)').run(keyId);
  }
  get configured(): boolean { return !!this.key; }
  seal(context: PayloadContext, value: unknown): SealedPayload {
    if (!this.key) fail(503, 'command_payload_key_required');
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(aad(context));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { payload_ciphertext: ciphertext.toString('base64url'), payload_nonce: nonce.toString('base64url'), payload_tag: cipher.getAuthTag().toString('base64url') };
  }
  open(context: PayloadContext, sealed: SealedPayload): unknown {
    if (!this.key) fail(503, 'command_payload_key_required');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, decode(sealed.payload_nonce, 12));
      decipher.setAAD(aad(context)); decipher.setAuthTag(decode(sealed.payload_tag, 16));
      const plaintext = Buffer.concat([decipher.update(decode(sealed.payload_ciphertext)), decipher.final()]);
      try { return JSON.parse(plaintext.toString('utf8')); } finally { plaintext.fill(0); }
    } catch { fail(503, 'command_payload_corrupt'); }
  }
  close(): void { this.key?.fill(0); this.key = undefined; }
}
