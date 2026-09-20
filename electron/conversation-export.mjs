import path from 'node:path';
import { writeFile } from 'node:fs/promises';

export function exportPayload(value) {
  if (!value || !['markdown', 'html'].includes(value.format) || typeof value.content !== 'string' || Buffer.byteLength(value.content, 'utf8') > 32 * 1024 * 1024) throw new Error('Некорректный экспорт или файл больше 32 МиБ.');
  const extension = value.format === 'html' ? 'html' : 'md';
  const base = path.win32.basename(String(value.filename || 'Беседа')).replace(/\.(?:md|html)$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 150);
  const safe = !base || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base) ? 'Беседа' : base;
  return { filename: `${safe}.${extension}`, extension, content: value.content };
}

export async function saveConversation(value, choosePath) {
  const file = exportPayload(value);
  const selected = await choosePath({ title: 'Экспорт беседы', defaultPath: file.filename, filters: [{ name: file.extension === 'md' ? 'Markdown' : 'HTML', extensions: [file.extension] }] });
  if (selected.canceled || !selected.filePath) return { canceled: true };
  await writeFile(selected.filePath, file.content, 'utf8');
  return { canceled: false, path: selected.filePath };
}
