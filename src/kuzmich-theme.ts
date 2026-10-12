import { useEffect } from 'react';
import { useBuildInfo } from './BuildInfo';
import { isKuzmichChannel } from './product-identity';
import './kuzmich-theme.css';

/**
 * Брендовая тема каналов nightly и experimental3 живёт на корне документа: один data-атрибут включает
 * палитру и шрифты из kuzmich-theme.css. Модуль общий, потому что атрибут нужен и приложению,
 * и мастеру «Кузьмича», который UI-тест монтирует отдельно, без App.
 */
export const KUZMICH_THEME = 'kuzmich';

/**
 * Снять тему нельзя: канал сборки за время работы не меняется, а атрибут нужен и после
 * размонтирования App — например, на экране диагностики, который показывает сам себя,
 * когда интерфейс упал.
 */
export function applyKuzmichTheme() {
  document.documentElement.dataset.theme = KUZMICH_THEME;
}

/** `force` — для самого мастера Кузьмича: он существует только в этом канале. */
export function useKuzmichTheme(force = false) {
  const info = useBuildInfo();
  const enabled = force || Boolean(info && isKuzmichChannel(info.channel));
  useEffect(() => { if (enabled) applyKuzmichTheme(); }, [enabled]);
}
