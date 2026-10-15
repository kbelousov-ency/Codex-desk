import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createRelay } from '../src/server.ts';
import { FIXTURE_BOT_TOKEN } from '../src/fixtures.ts';

const origin = 'https://fixture-live.trycloudflare.com';
const proxyHeaders = { Host: 'fixture-live.trycloudflare.com', 'X-Forwarded-Proto': 'https', Origin: origin };

function http(port: number, path: string, headers: Record<string, string>) {
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, headers }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString('utf8'), headers: response.headers }));
    });
    req.on('error', reject); req.end();
  });
}

test('live production proxy serves Mini App only with HTTPS forwarding and permitted Origin', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-live-proxy-'));
  writeFileSync(join(directory, 'index.html'), '<!doctype html><title>Live launch test Mini App</title>');
  const relay = createRelay({ botToken: FIXTURE_BOT_TOKEN, fixtureMode: false,
    trustLoopbackProxy: true, allowedOrigins: [origin], staticDirectory: directory });
  try {
    const port = await relay.listen(0);
    const page = await http(port, '/', proxyHeaders);
    assert.equal(page.status, 200); assert.match(page.body, /Live launch test Mini App/);
    assert.match(String(page.headers['content-type']), /^text\/html/);
    assert.equal(page.headers['access-control-allow-origin'], origin);
    assert.equal((await http(port, '/?tgWebAppStartParam=synthetic', proxyHeaders)).status, 200);
    const foreign = await http(port, '/', { ...proxyHeaders, Origin: 'https://unrelated.invalid' });
    assert.equal(foreign.status, 403); assert.equal(JSON.parse(foreign.body).error.code, 'origin_not_allowed');
    assert.equal(foreign.headers['access-control-allow-origin'], undefined);
    for (const proto of ['', 'http', 'https,http']) {
      const headers: Record<string, string> = { ...proxyHeaders, 'X-Forwarded-Proto': proto };
      if (!proto) delete headers['X-Forwarded-Proto'];
      const rejected = await http(port, '/', headers);
      assert.equal(rejected.status, 400); assert.equal(JSON.parse(rejected.body).error.code, 'https_required');
    }
    const fixture = await http(port, '/api/dev/init-data', proxyHeaders);
    assert.equal(fixture.status, 404); assert.equal(JSON.parse(fixture.body).error.code, 'not_found');
  } finally {
    await relay.close();
    const target = realpathSync(directory);
    assert.equal(dirname(target), realpathSync(tmpdir())); assert.ok(basename(target).startsWith('relay-live-proxy-'));
    rmSync(target, { recursive: true, force: true });
  }
});

test('live bridge WebSocket applies the same HTTPS and Origin guards before upgrade', async () => {
  const relay = createRelay({ botToken: FIXTURE_BOT_TOKEN, fixtureMode: false,
    trustLoopbackProxy: true, allowedOrigins: [origin] });
  let socket: WebSocket | undefined;
  try {
    const port = await relay.listen(0), url = `ws://127.0.0.1:${port}/bridge/v2`;
    socket = new WebSocket(url, 'kuzmich-bridge.v2', { headers: proxyHeaders });
    const first = once(socket, 'message'); await once(socket, 'open');
    assert.equal(JSON.parse(String((await first)[0])).type, 'challenge');
    socket.close(); await once(socket, 'close');
    for (const [headers, expected] of [
      [{ ...proxyHeaders, Origin: 'https://unrelated.invalid' }, 403],
      [{ ...proxyHeaders, 'X-Forwarded-Proto': 'http' }, 400],
    ] as const) {
      socket = new WebSocket(url, 'kuzmich-bridge.v2', { headers });
      socket.on('error', () => {});
      const rejected = await once(socket, 'unexpected-response');
      assert.equal(rejected[1].statusCode, expected); rejected[1].resume(); socket.terminate();
    }
  } finally { socket?.terminate(); await relay.close(); }
});
