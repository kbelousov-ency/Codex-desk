import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { argv, exit } from 'node:process';

/**
 * Генератор src/kuzmich-theme-colors.css.
 *
 * Интерфейс приложения задаёт цвета прямо в правилах (1000+ разных значений в src/*.css),
 * поэтому переопределить токены :root недостаточно. Скрипт читает те же самые файлы и на
 * каждое правило с цветом выпускает такое же правило с префиксом [data-theme=kuzmich] —
 * префикс добавляет специфичность, поэтому порядок подключения не важен, а остальные каналы
 * не меняются вовсе: без атрибута ни одно из этих правил не применяется.
 *
 * Пересчёт цвета: светлота (L в HSL) сохраняется как есть — значит сохраняются и иерархия
 * поверхностей, и контраст текста, — а меняются тон и насыщенность:
 *   • мятно-бирюзовый акцент приложения сводится к серо-зелёному акценту дизайн-системы;
 *   • все прочие зелёно-серые — к одному тону 145° с «графитовой» насыщенностью;
 *   • тёплые цвета остаются состояниями (ошибка/предупреждение), но становятся сдержаннее;
 *   • серые (S < 4%) и прозрачные тени не трогаются.
 *
 * Запуск: node scripts/kuzmich-theme-colors.mjs (после правок цветов в src/*.css).
 * Проверка: node scripts/kuzmich-theme-colors.mjs --check — падает, если файл устарел;
 * её вызывает scripts/ui-kuzmich-setup.mjs, чтобы правка цвета не разъехалась с темой.
 */
const OUTPUT = 'src/kuzmich-theme-colors.css';
const THEME = '[data-theme=kuzmich]';

const toRgb = hex => {
  const body = hex.slice(1);
  const full = body.length <= 4 ? [...body].map(c => c + c).join('') : body;
  return { rgb: [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16)), alpha: full.length === 8 ? full.slice(6, 8) : '' };
};
const toHsl = ([r, g, b]) => {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return [0, 0, l * 100];
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60; if (h < 0) h += 360;
  return [h, (d / (1 - Math.abs(2 * l - 1))) * 100, l * 100];
};
const toHex = ([h, s, l]) => {
  s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return '#' + [r, g, b].map(value => Math.round((value + m) * 255).toString(16).padStart(2, '0')).join('');
};

/** Тон дизайн-системы и потолки насыщенности взяты из палитры Kuzmich_Design_System.md. */
const GREEN = 145;
function remap([h, s, l]) {
  if (s < 4) return null;                                                  // чистый серый и тени
  // Мятный акцент сводится к акценту дизайн-системы. Почти белый текст с зелёным отливом
  // (L ≥ 85%) под это правило не попадает: он остаётся текстом своей светлоты.
  // Светлота выше акцента дизайн-системы поджимается, а не срезается: иначе заливка кнопки
  // и её же состояние наведения схлопнулись бы в один цвет.
  if (h >= 120 && h < 200 && s >= 18 && l >= 55 && l < 85) return [GREEN, 16, l >= 66 ? 66 + (l - 66) * 0.35 : l];
  if ((h < 25 || h >= 330) && s >= 10) return [8, Math.min(s, 30), l];     // ошибки
  if (h >= 25 && h < 65 && s >= 10) return [45, Math.min(s, 26), l];       // предупреждения
  if (h >= 200 && h < 330 && s >= 18) return null;                         // осознанно синее (бейджи каналов)
  return [GREEN, Math.min(s, l > 60 ? 12 : l > 30 ? 10 : 7), l];
}
const mapColor = hex => {
  const { rgb, alpha } = toRgb(hex);
  const next = remap(toHsl(rgb));
  return next ? toHex(next) + alpha : null;
};

/** Правило применяется к корню — префикс должен остаться на том же элементе. */
const prefix = selector => selector.split(',').map(part => {
  const one = part.trim();
  if (!one) return '';
  if (one === ':root' || one === 'html') return `html${THEME}`;
  if (one.startsWith('html')) return `html${THEME}${one.slice(4)}`;
  return `${THEME} ${one}`;
}).filter(Boolean).join(',');

const files = readdirSync('src').filter(name => name.endsWith('.css') && !name.startsWith('kuzmich-theme'));
const chunks = [];
let rules = 0, declarations = 0;
for (const file of files) {
  const text = readFileSync(`src/${file}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = [];
  // Один уровень вложенности: @media/@supports с правилами внутри; @keyframes и @font-face пропускаем.
  for (const match of text.matchAll(/(@[a-z-]+[^{]*)\{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}|([^{}@]+)\{([^{}]*)\}/g)) {
    if (match[1]) {
      const at = match[1].trim();
      if (/^@(keyframes|font-face|charset|import)/.test(at)) continue;
      for (const inner of match[2].matchAll(/([^{}]+)\{([^{}]*)\}/g)) blocks.push({ at, selector: inner[1].trim(), body: inner[2] });
    } else if (match[3]) blocks.push({ at: '', selector: match[3].trim(), body: match[4] });
  }
  const byAt = new Map();
  for (const block of blocks) {
    const root = block.selector === ':root';
    const kept = [];
    for (const declaration of block.body.split(';')) {
      const text = declaration.trim();
      if (!text || !/#[0-9a-fA-F]{3,8}\b/.test(text)) continue;
      if (root && text.startsWith('--')) continue;                 // токены задаёт kuzmich-theme.css
      let changed = false;
      const next = text.replace(/#[0-9a-fA-F]{3,8}\b/g, hex => {
        if (![4, 5, 7, 9].includes(hex.length)) return hex;
        const mapped = mapColor(hex.toLowerCase());
        if (!mapped) return hex;
        changed = true;
        return mapped;
      });
      if (changed) kept.push(next);
    }
    if (!kept.length) continue;
    rules += 1; declarations += kept.length;
    if (!byAt.has(block.at)) byAt.set(block.at, []);
    byAt.get(block.at).push(`${prefix(block.selector)}{${kept.join(';')}}`);
  }
  if (!byAt.size) continue;
  const lines = [`/* ${file} */`];
  for (const [at, list] of byAt) lines.push(at ? `${at}{${list.join('')}}` : list.join('\n'));
  chunks.push(lines.join('\n'));
}

const header = `/* Создано scripts/kuzmich-theme-colors.mjs — не править руками.
   Перекраска жёстко заданных цветов src/*.css под тему «Кузьмича»: тон и насыщенность
   приводятся к палитре дизайн-системы, светлота сохраняется, поэтому контраст и иерархия
   поверхностей остаются прежними. Каждое правило ограничено ${THEME}, без атрибута
   на корне документа файл ни на что не влияет: другие каналы не меняются.
   Файл подключается первым (через @import в kuzmich-theme.css), чтобы ручные правила
   темы могли точечно его переопределять. */\n`;
const content = `${header}\n${chunks.join('\n\n')}\n`;
const summary = `${OUTPUT}: ${rules} rules, ${declarations} declarations, from ${files.length} stylesheets`;
if (argv.includes('--check')) {
  const current = (() => { try { return readFileSync(OUTPUT, 'utf8'); } catch { return ''; } })();
  if (current !== content) {
    console.error(`${OUTPUT} устарел: цвета в src/*.css изменились. Выполните: npm run theme:colors`);
    exit(1);
  }
  console.log(`${summary} — актуален`);
} else {
  writeFileSync(OUTPUT, content);
  console.log(summary);
}
