import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RouterConnectionStore, validateRouterConnection } from '../electron/router-connections.mjs';

const claude = {
  apiKey: 'router-test-secret-claude', baseUrl: 'https://router.example.test/anthropic', authScheme: 'bearer',
  providerName: 'Company router', model: 'claude-test-model', email: 'user@example.test',
};
const codex = {
  apiKey: 'router-test-secret-codex', baseUrl: 'https://router.example.test/v1', authScheme: 'bearer',
  providerId: 'company_router', providerName: 'Company router', model: 'codex-test-model',
  defaults: { model_context_window: 200000, model_auto_compact_token_limit: 170000, model_reasoning_summary: 'auto', hide_agent_reasoning: false },
};

async function fixture(overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-desk-router-connections-'));
  const key = randomBytes(32);
  const encrypt = value => {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
  };
  const decrypt = bytes => {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  };
  const changes = [];
  const options = { filename: path.join(directory, 'nested', 'router-connections.json'), encrypt, decrypt,
    onChange: (...args) => changes.push(args), ...overrides };
  return { store: new RouterConnectionStore(options), options, changes, directory,
    fresh: more => new RouterConnectionStore({ ...options, ...more }), cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('connection validation accepts explicit routes and returns independent normalized objects', () => {
  assert.deepEqual(validateRouterConnection('claude', claude), claude);
  assert.deepEqual(validateRouterConnection('claude', { ...claude, authScheme: 'api-key' }), { ...claude, authScheme: 'api-key' });
  const value = validateRouterConnection('codex', codex);
  value.defaults.model_context_window = 1;
  assert.equal(codex.defaults.model_context_window, 200000);
  assert.throws(() => validateRouterConnection('other', claude), /Некорректные/);
  assert.throws(() => validateRouterConnection('__proto__', claude), /Некорректные/);
});

test('Claude model aliases preserve explicit portal IDs without accepting arbitrary environment metadata', () => {
  const connection = { ...claude, modelAliases: { opus: 'cc/claude-opus-test[1m]', fable: 'cc/claude-fable-test[1m]', sonnet: 'cc/claude-sonnet-test', haiku: 'cc/claude-haiku-test' },
    modelNames: { opus: 'Opus test (1M)', fable: 'Fable test', sonnet: 'Sonnet test', haiku: 'Haiku test' } };
  const normalized = validateRouterConnection('claude', connection);
  assert.deepEqual(normalized, connection);
  normalized.modelAliases.opus = 'mutated';
  assert.equal(connection.modelAliases.opus, 'cc/claude-opus-test[1m]');
  for (const value of [
    { ...claude, modelAliases: { unknown: 'test' } }, { ...claude, modelAliases: { opus: 'bad model' } },
    { ...claude, modelAliases: { opus: 'name[evil]' } }, { ...claude, modelNames: { opus: claude.apiKey } },
    { ...claude, modelAliases: { opus: claude.apiKey } },
  ]) assert.throws(() => validateRouterConnection('claude', value), /Некорректные/);
  assert.throws(() => validateRouterConnection('codex', { ...codex, modelAliases: { opus: 'test' } }), /Некорректные/);
});

test('connection validation rejects arbitrary environment and configuration from remote responses', () => {
  const bad = [
    null, [], { ...claude, apiKey: 'bad\nkey' }, { ...claude, apiKey: '' }, { ...claude, apiKey: 'x'.repeat(8193) },
    { ...claude, env: { NODE_OPTIONS: '--require evil.js' } }, { ...claude, headers: { Authorization: 'x' } },
    { ...claude, authScheme: 'oauth' }, { ...claude, model: 'claude\n--foo' },
    { ...claude, providerId: '__proto__' }, { ...claude, providerId: 'a.b' },
    { ...claude, defaults: { model_context_window: 200000 } }, { ...claude, defaults: [] },
    { ...claude, providerName: '\u0000hidden' },
  ];
  for (const value of bad) assert.throws(() => validateRouterConnection('claude', value), /Некорректные/);
  for (const defaults of [
    { extra: true }, { model_context_window: 0 }, { model_context_window: 1.5 }, { model_context_window: 100000001 },
    { model_context_window: 10, model_auto_compact_token_limit: 11 }, { hide_agent_reasoning: 'false' },
    { model_reasoning_summary: 'unknown' },
  ]) assert.throws(() => validateRouterConnection('codex', { ...codex, defaults }), /Некорректные/);
  assert.throws(() => validateRouterConnection('codex', { ...codex, authScheme: 'api-key' }), /Некорректные/);
});

test('connection validation rejects unsafe URLs and secret-bearing public metadata', () => {
  for (const baseUrl of [
    'http://router.example.test', 'file:///secret', 'https://user:pass@router.example.test',
    'https://router.example.test/?token=key', 'https://router.example.test/#key', 'https://router.example.test/ a',
    `https://router.example.test/${claude.apiKey}`, `https://router.example.test/%72outer-test-secret-claude`,
    `https://router.example.test/%2572outer-test-secret-claude`,
  ]) assert.throws(() => validateRouterConnection('claude', { ...claude, baseUrl }), /Некорректные/);
  for (const field of ['providerId', 'providerName', 'model', 'email']) {
    assert.throws(() => validateRouterConnection('claude', { ...claude, [field]: `prefix-${claude.apiKey}` }), /Некорректные/);
  }
  try { validateRouterConnection('claude', { ...claude, providerName: claude.apiKey }); }
  catch (error) { assert.ok(!error.message.includes(claude.apiKey)); }
});

test('complete entries are encrypted at rest and public info never contains credentials', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.store.info('claude'), { configured: false, encryptionAvailable: true });
    assert.equal(await f.store.get('claude'), null);
    const saved = await f.store.set('claude', claude);
    assert.equal(saved.configured, true);
    assert.equal(saved.model, claude.model);
    assert.equal(Object.hasOwn(saved, 'apiKey'), false);
    assert.equal(JSON.stringify(saved).includes(claude.apiKey), false);
    const rawText = await readFile(f.store.filename, 'utf8'), raw = JSON.parse(rawText);
    assert.deepEqual(Object.keys(raw), ['version', 'entries']);
    for (const value of [claude.apiKey, claude.baseUrl, claude.model, claude.email, saved.savedAt]) assert.equal(rawText.includes(value), false);
    assert.deepEqual(JSON.parse(f.options.decrypt(Buffer.from(raw.entries.claude, 'base64'))), { connection: claude, savedAt: saved.savedAt });
    assert.deepEqual(await f.fresh().get('claude'), claude);
    assert.deepEqual(await f.fresh().info('claude'), saved);
    assert.deepEqual(f.changes, [['saved', 'claude']]);
  } finally { await f.cleanup(); }
});

test('agent entries and returned objects remain isolated across updates and removal', async () => {
  const f = await fixture();
  try {
    await Promise.all([f.store.set('claude', claude), f.store.set('codex', codex)]);
    const copy = await f.store.get('codex');
    copy.apiKey = 'mutated'; copy.defaults.model_context_window = 1;
    assert.deepEqual(await f.store.get('codex'), codex);
    await f.store.clear('claude');
    assert.equal(await f.fresh().get('claude'), null);
    assert.deepEqual(await f.fresh().get('codex'), codex);
    await f.store.clear('codex');
    await assert.rejects(readFile(f.store.filename), { code: 'ENOENT' });
    await f.store.clear('codex');
    await f.store.flush();
  } finally { await f.cleanup(); }
});

test('unavailable encryption and failed encryption never save plaintext or report configured', async () => {
  const f = await fixture({ available: () => false });
  try {
    await assert.rejects(f.store.set('claude', claude), /Шифрование/);
    assert.deepEqual(await f.store.info('claude'), { configured: false, encryptionAvailable: false });
    await assert.rejects(readFile(f.store.filename), { code: 'ENOENT' });
    await assert.rejects(f.fresh({ available: () => true, encrypt: () => { throw new Error(claude.apiKey); } }).set('claude', claude), error => !error.message.includes(claude.apiKey));
    assert.deepEqual(f.changes, []);
  } finally { await f.cleanup(); }
});

test('corrupt entry fails closed and can be replaced without losing another agent', async () => {
  const f = await fixture();
  try {
    await f.store.set('claude', claude);
    await f.store.set('codex', codex);
    const raw = JSON.parse(await readFile(f.store.filename, 'utf8'));
    raw.entries.claude = 'corrupted ciphertext';
    await writeFile(f.store.filename, JSON.stringify(raw));
    const fresh = f.fresh();
    await assert.rejects(fresh.get('claude'), /не читается/);
    assert.deepEqual(await fresh.info('claude'), { configured: false, encryptionAvailable: true, error: 'Сохранённое подключение роутера не читается. Подключите роутер заново.' });
    assert.deepEqual(await fresh.get('codex'), codex);
    await fresh.set('claude', claude);
    assert.deepEqual(await f.fresh().get('codex'), codex);
    assert.deepEqual(await fresh.get('claude'), claude);
    const unavailableStore = f.fresh({ available: () => false });
    await assert.rejects(unavailableStore.get('claude'), /Шифрование/);
    assert.equal((await unavailableStore.info('claude')).configured, false);
  } finally { await f.cleanup(); }
});

test('encrypted invalid metadata, malformed envelope and foreign encryption report only generic errors', async () => {
  const f = await fixture();
  try {
    await f.store.set('claude', claude);
    const foreign = f.fresh({ decrypt: () => { throw new Error(claude.apiKey); } });
    await assert.rejects(foreign.get('claude'), error => /не читается/.test(error.message) && !error.message.includes(claude.apiKey));
    const encrypted = f.options.encrypt(JSON.stringify({ connection: { ...claude, email: claude.apiKey }, savedAt: new Date().toISOString() })).toString('base64');
    await writeFile(f.store.filename, JSON.stringify({ version: 1, entries: { claude: encrypted } }));
    await assert.rejects(f.fresh().get('claude'), /не читается/);
    await f.fresh().clear('claude');
    assert.equal(await f.fresh().get('claude'), null);
    for (const raw of ['not json', JSON.stringify({ version: 2, entries: {} }), JSON.stringify({ version: 1, entries: { other: encrypted } })]) {
      await writeFile(f.store.filename, raw);
      await assert.rejects(f.fresh().get('claude'), /не читается/);
      await assert.rejects(f.fresh().set('claude', claude), /не читается/);
      assert.equal(await readFile(f.store.filename, 'utf8'), raw, 'unrecognized envelope must not be overwritten');
    }
  } finally { await f.cleanup(); }
});

test('failed replacement retains the previous saved connection and removes temporary files', async () => {
  const f = await fixture();
  try {
    await f.store.set('claude', claude);
    const previous = await readFile(f.store.filename, 'utf8');
    const failing = f.fresh({ encrypt: () => { throw new Error(claude.apiKey); } });
    await assert.rejects(failing.set('claude', { ...claude, model: 'new-model' }), /зашифровать/);
    assert.equal(await readFile(f.store.filename, 'utf8'), previous);
    const filename = path.join(f.directory, 'blocked');
    await mkdir(filename);
    const blocked = f.fresh({ filename });
    blocked.cache = {};
    await assert.rejects(blocked.set('claude', claude), /сохранить/);
    assert.equal((await readdir(f.directory)).some(name => name.endsWith('.tmp')), false);
    assert.deepEqual(await f.fresh().get('claude'), claude);
  } finally { await f.cleanup(); }
});
