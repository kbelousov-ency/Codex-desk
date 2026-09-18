export const standardCommands = [
  { name: 'compact', label: 'Сжать контекст', description: 'Запустить штатный compact текущего диалога' },
  { name: 'new', label: 'Новый диалог', description: 'Открыть вкладку в текущей папке' },
  { name: 'status', label: 'Токены и контекст', description: 'Закрепить подробности использования токенов' },
  { name: 'model', label: 'Выбрать модель', description: 'Открыть список доступных моделей' },
  { name: 'permissions', label: 'Настроить доступ', description: 'Открыть режимы разрешений Codex' },
  { name: 'resume', label: 'История диалогов', description: 'Выбрать сохранённую беседу этой папки' },
  { name: 'help', label: 'Команды', description: 'Показать поддерживаемые команды оболочки' },
] as const;
export type CommandName = typeof standardCommands[number]['name'];
export function parseSlashCommand(text: string): { name: string; known: boolean; args: string } | null {
  const match = /^\/([a-z][a-z\d_-]*)(?:[ \t]+([^\r\n]*))?$/i.exec(text.trim());
  if (!match) return null;
  const name = match[1].toLowerCase();
  const known = standardCommands.some(command => command.name === name);
  // Paths such as /src/file and ordinary prose are regular model input.
  if (!known && match[2]) return null;
  return { name, known, args: match[2]?.trim() || '' };
}
export function matchingCommands(text: string, all = false) {
  if (all) return [...standardCommands];
  if (!/^\/[a-z]*$/i.test(text.trim())) return [];
  const prefix = text.trim().slice(1).toLowerCase();
  return standardCommands.filter(command => command.name.startsWith(prefix));
}
