import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const svg = await readFile(new URL('../electron/kuzmich-logo.svg', import.meta.url), 'utf8');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 256, height: 256 }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  const png = await page.locator('svg').screenshot({ omitBackground: true });
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  await writeFile(new URL('../electron/kuzmich.ico', import.meta.url), Buffer.concat([header, png]));
} finally {
  await browser.close();
}
