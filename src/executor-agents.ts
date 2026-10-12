/** Default names for executor agents («Агент A», «Агент B», …).
 *
 * An executor agent is a plain empty conversation of the same folder that is linked to its
 * parent for navigation only: no parent context is ever copied into it. The default name is
 * the next free Latin letter among the executors of that one parent, so the row reads as a
 * short roster instead of a list of «Новый диалог». Pure logic, no React and no IPC. */

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Bijective base-26 suffix: A…Z, then AA, AB, … so the sequence never runs out. */
export const executorLetter = (index: number): string => {
  let value = Math.max(0, Math.floor(index));
  let suffix = '';
  while (value >= 0) {
    suffix = LETTERS[value % 26] + suffix;
    value = Math.floor(value / 26) - 1;
  }
  return suffix;
};

export const executorLabel = (index: number): string => `Агент ${executorLetter(index)}`;

/** Letter of a default executor name, or '' for any other title the user has typed. */
export const executorLabelLetter = (value?: string | null): string => {
  const match = typeof value === 'string' ? /^Агент\s+([A-Za-z]+)$/i.exec(value.trim()) : null;
  return match ? match[1].toUpperCase() : '';
};

/** First «Агент …» name that is not in `taken`. Titles that are not default names are ignored. */
export const nextExecutorLabel = (taken: Iterable<string | null | undefined>): string => {
  const used = new Set<string>();
  for (const value of taken) {
    const letter = executorLabelLetter(value);
    if (letter) used.add(letter);
  }
  for (let index = 0; ; index += 1) {
    const letter = executorLetter(index);
    if (!used.has(letter)) return executorLabel(index);
  }
};

export const executorCountText = (count: number): string => {
  const hundred = Math.abs(count) % 100;
  const tail = hundred >= 11 && hundred <= 14 ? 0 : Math.abs(count) % 10;
  return `${count} ${tail === 1 ? 'агент-исполнитель' : tail >= 2 && tail <= 4 ? 'агента-исполнителя' : 'агентов-исполнителей'}`;
};
