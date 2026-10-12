import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { productNameForChannel, productNameGenitive, isKuzmichChannel } from '../src/product-identity.ts';

test('renderer brand matches host channel identity without merging channel IDs', () => {
  for (const channel of ['nightly', 'experimental3']) {
    assert.equal(isKuzmichChannel(channel), true);
    assert.equal(productNameForChannel(channel), 'Кузьмич');
    assert.equal(productNameGenitive(channel), 'Кузьмича');
  }
  for (const channel of ['stable', 'development']) {
    assert.equal(isKuzmichChannel(channel), false);
    assert.equal(productNameForChannel(channel), 'Кузьмич');
    assert.equal(productNameGenitive(channel), 'Кузьмича');
  }
});

test('Nightly branding does not enable the Experimental 3 router-only workflow', async () => {
  const host = await readFile(new URL('../electron/main.mjs', import.meta.url), 'utf8');
  assert.match(host, /const routerOnly = releaseInfo\.channel === 'experimental3';/);
  assert.match(host, /app\.setPath\('userData', channelPaths\.userData\)/);
  const wizard = await readFile(new URL('../src/SetupGate.tsx', import.meta.url), 'utf8');
  assert.match(wizard, /const Wizard = experimental3 \? KuzmichSetupWizard : SetupWizard;/);
});

test('owner logo is one offline embedded 512px RGBA bitmap behind the stable SVG entry point', async () => {
  // Since 2026-10-10 the mark is the owner's rendered tile, not a drawn vector.
  // The SVG stays the single entry point so the renderer and icon pipeline are unchanged.
  const svg = await readFile(new URL('../electron/kuzmich-logo.svg', import.meta.url), 'utf8');
  assert.match(svg, /viewBox="0 0 512 512"/);
  assert.match(svg, /width="256" height="256"/);
  assert.equal((svg.match(/<image /g) || []).length, 1);
  const embedded = svg.match(/href="data:image\/png;base64,([^"]+)"/);
  assert.ok(embedded, 'the logo bitmap is embedded as a data URI');
  const png = Buffer.from(embedded[1], 'base64');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 512);
  assert.equal(png.readUInt32BE(20), 512);
  assert.equal(png[25], 6, 'RGBA keeps the rounded corners transparent');
  assert.doesNotMatch(svg, /href="https?:|src=|<text|<filter|<animate|<script/);
  const icon = await readFile(new URL('../electron/kuzmich.ico', import.meta.url));
  assert.equal(icon.readUInt16LE(2), 1);
  assert.equal(icon.readUInt16LE(4), 1);
  assert.equal(icon.readUInt32LE(18), 22);
  assert.equal(icon.subarray(22, 30).toString('hex'), '89504e470d0a1a0a');
  const packaging = await readFile(new URL('../scripts/package.mjs', import.meta.url), 'utf8');
  assert.match(packaging, /const branding = applicationBuildIdentity\(channel\)/);
  assert.match(packaging, /--config\.win\.icon=electron\/\$\{branding.iconName\}/);
  assert.match(packaging, /--config\.productName=\$\{branding.productName\}/);
  assert.match(packaging, /--config\.executableName=\$\{branding.executableName\}/);
  assert.match(packaging, /productName: branding.productName, iconName: branding.iconName/);
  assert.match(packaging, /JSON.stringify\(\{ files: checksums, branding \}\)/);
  assert.match(packaging, /channel === 'stable' \? 'Codex Desk\.exe' : 'Kuzmich\.exe'/);
});
