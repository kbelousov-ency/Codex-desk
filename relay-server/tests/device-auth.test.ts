import assert from 'node:assert/strict';
import test from 'node:test';
import { publicKeyObject, verifyDeviceProof, verifyEd25519 } from '../src/device-auth.ts';

// RFC 8032 section 7.1, TEST 1. Expected values are fixed independently of Node crypto.
const PUBLIC = 'MCowBQYDK2VwAyEA11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo';
const EMPTY_SIGNATURE = Buffer.from('e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b', 'hex').toString('base64url');
// Independently calculated with pure-Python RFC Edwards arithmetic after checking TEST 1 above.
const INSTALLATION = '123e4567-e89b-42d3-a456-426614174000';
const NONCE = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const WIRE_SIGNATURE = 'V9f30qohaaPzJutzVM0smiAZVKSUG3Tl1mMMRkRiQIoL_pvHkqWAH0nyDN--oypp4TbTHbVX3W3qNVfc70h_AQ';

test('Ed25519 accepts fixed RFC 8032 vector and independently computed protocol 2.1 domain signature', () => {
  assert.equal(publicKeyObject(PUBLIC).asymmetricKeyType, 'ed25519');
  assert.equal(verifyEd25519(PUBLIC, new Uint8Array(), EMPTY_SIGNATURE), true);
  assert.equal(verifyDeviceProof(PUBLIC, INSTALLATION, NONCE, WIRE_SIGNATURE), true);
});

test('Ed25519 rejects wrong challenge, installation, domain, key and tampered signature', () => {
  assert.equal(verifyDeviceProof(PUBLIC, INSTALLATION, NONCE + 'x', WIRE_SIGNATURE), false);
  assert.equal(verifyDeviceProof(PUBLIC, INSTALLATION.replace('123e', '223e'), NONCE, WIRE_SIGNATURE), false);
  assert.equal(verifyEd25519(PUBLIC, Buffer.from(`another-domain\n${INSTALLATION}\n${NONCE}`), WIRE_SIGNATURE), false);
  const wrongKey = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from('3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c', 'hex')]).toString('base64url');
  assert.equal(verifyDeviceProof(wrongKey, INSTALLATION, NONCE, WIRE_SIGNATURE), false);
  assert.equal(verifyDeviceProof(PUBLIC, INSTALLATION, NONCE, 'A' + WIRE_SIGNATURE.slice(1)), false);
});

test('public keys and signatures require canonical exact-length Ed25519 encodings', () => {
  const bytes = Buffer.from(PUBLIC, 'base64url');
  const x25519 = Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), bytes.subarray(12)]).toString('base64url');
  for (const value of [PUBLIC + '=', bytes.subarray(12).toString('base64url'), Buffer.concat([bytes, Buffer.from([0])]).toString('base64url'), x25519, 'PRIVATE_KEY']) {
    assert.throws(() => publicKeyObject(value), { code: 'invalid_public_key' });
  }
  for (const value of [WIRE_SIGNATURE + '=', WIRE_SIGNATURE.slice(0, -1) + 'R', WIRE_SIGNATURE.slice(1), 'A'.repeat(43)]) {
    assert.equal(verifyDeviceProof(PUBLIC, INSTALLATION, NONCE, value), false);
  }
});
