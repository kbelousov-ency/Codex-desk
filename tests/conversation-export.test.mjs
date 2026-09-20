import assert from 'node:assert/strict';
import test from 'node:test';
import { exportEntries, exportFilename, exportMarkdown, fencedText } from '../src/conversation-export.ts';

const items = [
  { id: 'user', type: 'userMessage', turnId: 'turn', content: [{ type: 'text', text: 'Проверь <script>alert(1)</script>\n```' }, { type: 'localImage', path: 'C:/image.png' }] },
  { id: 'reasoning', type: 'reasoning', summary: ['Полученное пояснение'], encrypted_content: 'PRIVATE_REASONING' },
  { id: 'comment', type: 'agentMessage', phase: 'commentary', text: 'Проверяю' },
  { id: 'tool', type: 'commandExecution', command: 'git status', aggregatedOutput: 'clean', exitCode: 0, extraPrivate: 'PRIVATE_EVENT', arguments: { text: 'visible', encrypted_content: 'PRIVATE_ARGUMENT', payload: { type: 'encrypted_content', text: 'PRIVATE_CONTENT' } } },
  { id: 'hidden', type: 'hookPrompt', text: 'PRIVATE_HOOK' },
  { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '**Готово**' },
  { id: 'legacy', type: 'agentMessage', text: 'Ответ без phase' },
];
const info = { title: 'Беседа #1', provider: 'Claude', cwd: 'C:/project', partial: false, busy: false, scope: 'conversation', turnWork: { turn: { id: 'turn', status: 'completed', startedAt: 1700000000000, durationMs: 1234 } } };

test('conversation export preserves final and legacy answers, user text and attachment paths', () => {
  const entries = exportEntries(items, 'conversation', 'Claude');
  assert.deepEqual(entries.map(entry => entry.id), ['user', 'answer', 'legacy']);
  const markdown = exportMarkdown(entries, info);
  assert.match(markdown, /C:\/image.png/);
  assert.match(markdown, /\*\*Готово\*\*/);
  assert.match(markdown, /2023-11-14T22:13:20.000Z/);
  assert.match(markdown, /````\nПроверь <script>/);
  assert.ok(!markdown.includes('Проверяю'));
  assert.ok(!markdown.includes('git status'));
});

test('work export includes public tool fields and comments without raw private event payloads', () => {
  const markdown = exportMarkdown(exportEntries(items, 'work', 'Codex'), { ...info, scope: 'work', partial: true, busy: true });
  for (const expected of ['git status', 'Полученное пояснение', 'Проверяю', 'clean', 'visible', 'загруженный фрагмент', 'Снимок во время работы']) assert.ok(markdown.includes(expected), expected);
  assert.ok(!markdown.includes('PRIVATE_'));
});

test('filename, heading and fences cannot create paths or escape Markdown code blocks', () => {
  assert.equal(exportFilename('../CON:*?\r\n', 'html'), '..-CON-----.html');
  assert.equal(exportFilename('CON', 'markdown'), 'Беседа-CON.md');
  assert.equal(exportFilename('   ', 'markdown'), 'Беседа.md');
  const payload = '`````\n<script>alert(1)</script>\n~~~';
  assert.equal(fencedText(payload), `\`\`\`\`\`\`\n${payload}\n\`\`\`\`\`\``);
  const markdown = exportMarkdown([], { ...info, title: 'Hello\n# injected' });
  assert.ok(markdown.startsWith('# Hello \\# injected\n'));
});
