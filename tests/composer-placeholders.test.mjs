import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { composerPlaceholderLibraries, createPlaceholderRotation, placeholderContext, selectComposerPlaceholder } from '../src/composer-placeholders.ts';

const randomPair = (tier, phrase) => { let calls = 0; return () => calls++ % 2 ? phrase : tier; };

test('phrase libraries match every supplied phrase and tier exactly', async () => {
  const instructions = await readFile(new URL('../Kuzmich_Placeholder_Rotation_Instructions.md', import.meta.url), 'utf8');
  const sections = instructions.split('## Phrase library: ').slice(1);
  for (const [index, context] of ['new', 'continuing'].entries()) {
    const tiers = sections[index].split('### ').slice(1);
    for (const [tierIndex, tier] of ['often', 'sometimes', 'rarely'].entries()) {
      const phrases = [...tiers[tierIndex].matchAll(/^-\s+«(.+)»\s*$/gm)].map(match => match[1]);
      assert.deepEqual(composerPlaceholderLibraries[context][tier], phrases);
    }
  }
});

test('restored thread IDs select continuing work; new sessions select new project', () => {
  assert.equal(placeholderContext(), 'new');
  assert.equal(placeholderContext(''), 'new');
  assert.equal(placeholderContext('existing-thread'), 'continuing');
  for (const context of ['new', 'continuing']) {
    const allowed = Object.values(composerPlaceholderLibraries[context]).flat();
    const next = createPlaceholderRotation(randomPair(0.6, 0.3));
    for (let selection = 0; selection < 50; selection++) assert.ok(allowed.includes(next(context)));
  }
});

test('tier choice has exact 50/35/15 boundaries, independent of phrase counts', () => {
  const counts = { often: 0, sometimes: 0, rarely: 0 };
  const library = { often: ['often'], sometimes: ['sometimes', 'sometimes-2'], rarely: ['rarely', 'rarely-2', 'rarely-3'] };
  for (let selection = 0; selection < 10000; selection++) counts[selectComposerPlaceholder(library, [], randomPair(selection / 10000, 0))]++;
  assert.deepEqual(counts, { often: 5000, sometimes: 3500, rarely: 1500 });
});

test('selection inside each tier is uniform, including after recent-phrase exclusions', () => {
  for (const [tier, roll] of [['often', 0], ['sometimes', 0.5], ['rarely', 0.85]]) {
    const library = composerPlaceholderLibraries.new;
    const candidates = library[tier].slice(1);
    for (const [index, phrase] of candidates.entries()) {
      assert.equal(selectComposerPlaceholder(library, [library[tier][0]], randomPair(roll, (index + 0.5) / candidates.length)), phrase);
    }
  }
});

test('rotation never repeats the previous five, including phrases shared across libraries', () => {
  const next = createPlaceholderRotation(randomPair(0, 0));
  const recent = [];
  for (let selection = 0; selection < 200; selection++) {
    const phrase = next(selection % 2 ? 'continuing' : 'new');
    assert.ok(!recent.includes(phrase));
    recent.push(phrase); if (recent.length > 5) recent.shift();
  }
});

test('unavailable tiers fall back locally, relaxing the five-item window but never the last phrase', () => {
  assert.equal(selectComposerPlaceholder({ often: [], sometimes: ['local'], rarely: [] }, [], randomPair(0, 0)), 'local');
  assert.equal(selectComposerPlaceholder({ often: ['older', 'last'], sometimes: [], rarely: [] }, ['older', 'last'], randomPair(0, 0)), 'older');
  assert.equal(selectComposerPlaceholder({ often: ['last'], sometimes: ['other'], rarely: [] }, ['last'], randomPair(0, 0)), 'other');
  assert.equal(selectComposerPlaceholder({ often: ['last'], sometimes: [], rarely: [] }, ['last'], randomPair(0, 0)), '');
  assert.equal(selectComposerPlaceholder({ often: [], sometimes: [], rarely: [] }), '');
});
