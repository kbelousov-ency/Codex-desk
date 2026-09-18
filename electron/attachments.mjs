import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

/** Only app-owned attachments may be read through the renderer bridge. */
export async function readAttachment(attachmentsDirectory, target) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) return null;
  try {
    const dir = await realpath(attachmentsDirectory);
    const resolved = await realpath(target);
    const relative = path.relative(dir, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    const extension = path.extname(resolved).slice(1).toLowerCase();
    const mime = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp', gif: 'gif' }[extension];
    if (!mime) return null;
    const bytes = await readFile(resolved);
    if (bytes.length > 20 * 1024 * 1024) return null;
    return `data:image/${mime};base64,${bytes.toString('base64')}`;
  } catch { return null; }
}

export async function hydrateAttachmentPreviews(items, attachmentsDirectory) {
  return Promise.all(items.map(async item => {
    if (item.type !== 'userMessage' || item.previews?.length) return item;
    const images = (item.content || []).filter(part => ['image', 'localImage'].includes(part.type));
    if (!images.length) return item;
    const previews = await Promise.all(images.map(async part => {
      const dataUrl = part.path ? await readAttachment(attachmentsDirectory, part.path) : typeof part.url === 'string' && part.url.startsWith('data:image/') ? part.url : undefined;
      return { name: part.path ? path.basename(part.path) : 'Изображение', path: part.path, dataUrl: dataUrl || undefined };
    }));
    return { ...item, previews };
  }));
}
