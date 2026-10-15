import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { fail } from './security.ts';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Wire 2.1 accepts canonical unpadded base64url SPKI DER, never a private or raw key. */
export function publicKeyObject(value: unknown): KeyObject {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{59}$/.test(value)) fail(400, 'invalid_public_key');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 44 || bytes.toString('base64url') !== value || !bytes.subarray(0, 12).equals(ED25519_SPKI_PREFIX)) fail(400, 'invalid_public_key');
  let key: KeyObject;
  try { key = createPublicKey({ key: bytes, format: 'der', type: 'spki' }); } catch { fail(400, 'invalid_public_key'); }
  if (key.asymmetricKeyType !== 'ed25519' || key.type !== 'public') fail(400, 'invalid_public_key');
  return key;
}

export function verifyEd25519(publicKey: string, message: Uint8Array, signature: unknown): boolean {
  try {
    if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
    const bytes = Buffer.from(signature, 'base64url');
    if (bytes.length !== 64 || bytes.toString('base64url') !== signature) return false;
    return verify(null, message, publicKeyObject(publicKey), bytes);
  } catch { return false; }
}

export function verifyDeviceProof(publicKey: string, installationId: string, serverNonce: string, signature: unknown): boolean {
  return verifyEd25519(publicKey, Buffer.from(`kuzmich-bridge-v2\n${installationId}\n${serverNonce}`, 'utf8'), signature);
}
