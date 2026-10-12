/** Copy renderer text through the clipboard surface already used by the chat UI. */
export async function copyText(value: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) throw new Error('Буфер обмена недоступен.');
  await navigator.clipboard.writeText(value);
}
