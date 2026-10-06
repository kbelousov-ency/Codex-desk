import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadClaudeInstallerConfig, isClaudeInstallerDownloadUrl, parseClaudeInstallerScript } from '../electron/claude-portal-import.mjs';

const ticket = 'fixture_ticket_ABCDEFGHIJKLMNOPQRSTUVWXYZ12';
const origin = 'https://coder-portal.encycam.com';
const downloadUrl = `${origin}/api/connect/claude/${ticket}.exe`;
const installerPath = `C:\\Downloads\\claude-connect-${ticket}.exe`;
const env = {
  ANTHROPIC_BASE_URL: 'https://router.example.test', ANTHROPIC_AUTH_TOKEN: 'private-router-fixture',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'cc/claude-opus-5-5[1m]',
  ANTHROPIC_DEFAULT_FABLE_MODEL: 'cc/claude-fable-5-1[1m]',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'cc/claude-sonnet-5-5',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'cc/claude-haiku-4-5',
  ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'Claude Opus 5.5',
  ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'Claude Fable 5.1',
  ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'Claude Sonnet 5.5',
  ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'Claude Haiku 4.5',
  ENABLE_PROMPT_CACHING_1H: '1', ENABLE_TOOL_SEARCH: 'true',
  UNRELATED_SETTING: 'ignored',
};
const script = (value = env) => `$ErrorActionPreference = 'Stop'\n$envJson = @'\n${JSON.stringify(value, null, 2)}\n'@\nWrite-Output 'script must not execute'\n`;
const response = value => new Response(value, { headers: { 'Content-Type': 'text/plain' } });

test('static extraction keeps only verified connection and typed model routing fields', () => {
  const config = parseClaudeInstallerScript(script());
  assert.equal(config.apiKey, env.ANTHROPIC_AUTH_TOKEN);
  assert.equal(config.baseUrl, env.ANTHROPIC_BASE_URL);
  assert.equal(config.authScheme, 'bearer');
  assert.deepEqual(config.modelAliases, { opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL, fable: env.ANTHROPIC_DEFAULT_FABLE_MODEL,
    sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL, haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL });
  assert.equal(config.modelNames.opus, 'Claude Opus 5.5');
  assert.equal('env' in config, false);
  assert.doesNotMatch(JSON.stringify(config), /ENABLE_|UNRELATED_SETTING|script must not execute/);
  assert.deepEqual(parseClaudeInstallerScript(script().replaceAll('\n', '\r\n')), config);
});

test('ticket from selected local installer or observed download goes only to its fixed portal script route', async () => {
  for (const source of [installerPath, downloadUrl, `/tmp/claude-connect-${ticket} (1).exe`]) {
    let request;
    const config = await downloadClaudeInstallerConfig(source, { fetchImpl: async (url, options) => {
      request = { url, options }; return response(script());
    } });
    assert.equal(request.url, `${origin}/api/connect/claude/${ticket}.ps1`);
    assert.equal(request.options.redirect, 'error');
    assert.equal(request.options.credentials, 'omit');
    assert.equal(request.options.headers.Authorization, undefined);
    assert.equal(config.apiKey, env.ANTHROPIC_AUTH_TOKEN);
  }
});

test('download matching rejects another portal, product, arbitrary paths and extra query secrets', async () => {
  assert.equal(isClaudeInstallerDownloadUrl(downloadUrl), true);
  for (const value of [
    downloadUrl.replace(origin, 'https://evil.example'), downloadUrl.replace('/claude/', '/codex/'),
    `${downloadUrl}?token=extra`, `${downloadUrl}#extra`, downloadUrl.replace('.exe', '.ps1'),
    `${origin}/other/claude-connect-${ticket}.exe`, `https://user:pass@coder-portal.encycam.com/api/connect/claude/${ticket}.exe`,
    `C:\\Downloads\\codex-connect-${ticket}.exe`, `C:\\Downloads\\claude-connect-short.exe`,
  ]) {
    assert.equal(isClaudeInstallerDownloadUrl(value), false);
    await assert.rejects(downloadClaudeInstallerConfig(value, { fetchImpl: () => { throw new Error('must not fetch'); } }), { code: 'invalid_installer' });
  }
});

test('only one literal JSON here-string is accepted; PowerShell expressions are not evaluated', () => {
  for (const text of [
    script().replace(JSON.stringify(env.ANTHROPIC_AUTH_TOKEN), '$(Get-Content secrets)'),
    `${script()}\n${script()}`, script({ ...env, ANTHROPIC_AUTH_TOKEN: undefined }),
    script({ ...env, ANTHROPIC_BASE_URL: 'http://unsafe.example' }),
    script({ ...env, ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: env.ANTHROPIC_AUTH_TOKEN }),
    script({ ...env, ANTHROPIC_DEFAULT_OPUS_MODEL: 'bad\nmodel' }),
    script(JSON.parse('{"__proto__":{},"ANTHROPIC_AUTH_TOKEN":"fixture"}')),
  ]) assert.throws(() => parseClaudeInstallerScript(text), { code: 'invalid_response' });
  assert.throws(() => parseClaudeInstallerScript('Write-Error "Ticket expired"'), { code: 'expired' });
});

test('expired tickets and raw transport errors never disclose ticket, response text or API key', async () => {
  for (const status of [401, 403, 404, 410]) {
    await assert.rejects(downloadClaudeInstallerConfig(downloadUrl, { fetchImpl: async () => new Response(ticket, { status }) }),
      cause => cause.code === 'expired' && !cause.message.includes(ticket));
  }
  await assert.rejects(downloadClaudeInstallerConfig(downloadUrl, { fetchImpl: async () => { throw new Error(`${downloadUrl} ${env.ANTHROPIC_AUTH_TOKEN}`); } }),
    cause => cause.code === 'network' && !cause.message.includes(ticket) && !cause.message.includes(env.ANTHROPIC_AUTH_TOKEN));
  await assert.rejects(downloadClaudeInstallerConfig(downloadUrl, { fetchImpl: async () => response('ticket already used') }), { code: 'expired' });
});

test('response byte cap cancels the stream before a large script can be buffered', async () => {
  let cancelled = false;
  await assert.rejects(downloadClaudeInstallerConfig(downloadUrl, { fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(64 * 1024)); }, cancel() { cancelled = true; },
  })) }), { code: 'invalid_response' });
  assert.equal(cancelled, true);
});

test('deadline includes an unresponsive stream and even a fetch that ignores abort', async () => {
  for (const fetchImpl of [() => new Promise(() => {}), async () => new Response(new ReadableStream({ start() {} }))]) {
    let expire, cleared = false;
    const pending = downloadClaudeInstallerConfig(downloadUrl, { fetchImpl,
      setTimeoutImpl(fn) { expire = fn; return 1; }, clearTimeoutImpl() { cleared = true; } });
    await Promise.resolve();
    expire();
    await assert.rejects(pending, { code: 'timeout' });
    assert.equal(cleared, true);
  }
});
