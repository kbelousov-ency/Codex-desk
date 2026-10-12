# Шрифты темы «Кузьмич»

Файлы лежат в репозитории и подключаются только через `@font-face` в `src/kuzmich-theme.css`.
Загрузки из сети нет: CSP в `index.html:6` разрешает `font-src 'self' data:`, и этого достаточно,
потому что Vite складывает TTF рядом со сборкой.

Все три семейства распространяются по SIL Open Font License 1.1; текст лицензии каждого — рядом,
в файлах `*-OFL.txt` (скопированы из того же апстрима, что и сами шрифты).

| Файл | Семейство, начертание | Версия | Размер | Источник (скачано 2026-10-09) |
|---|---|---|---|---|
| `RussoOne-Regular.ttf` | Russo One Regular | 1.001 | 39 124 Б | `https://raw.githubusercontent.com/google/fonts/main/ofl/russoone/RussoOne-Regular.ttf` |
| `IBMPlexSans-Regular.ttf` | IBM Plex Sans Regular | 3.005 | 200 500 Б | релиз `@ibm/plex-sans@1.1.0`, `ibm-plex-sans.zip` → `fonts/complete/ttf/` |
| `IBMPlexSans-Medium.ttf` | IBM Plex Sans Medium | 3.005 | 202 460 Б | тот же архив |
| `IBMPlexSans-SemiBold.ttf` | IBM Plex Sans SemiBold | 3.005 | 202 632 Б | тот же архив |
| `IBMPlexMono-Regular.ttf` | IBM Plex Mono Regular | 2.005 | 173 052 Б | релиз `@ibm/plex-mono@2.5.0`, `ibm-plex-mono.zip` → `fonts/complete/ttf/` |

Релизы IBM Plex: `https://github.com/IBM/plex/releases`. Каталог `fonts/complete/ttf` — это полный
набор знаков (не веб-сабсет), поэтому кириллица на месте.

SHA-256 скачанных файлов:

```
bc0abcc660bd8b7ad3000ecb2898a27c58a29a50f7ec81652fa12e75148d09df  RussoOne-Regular.ttf
975dcda37d80f038dcd143c22e33ca2d97a0cc5a929aace1c749153b0fe1afa5  IBMPlexSans-Regular.ttf
331c8639d7598b2cde62a911a71db195e30cb655cd6bdf2e324a7e984955f907  IBMPlexSans-Medium.ttf
a20caf8286023a6a7a85e40b1d2a4ae9fc3e3b1f9eda8f4c542dd4986af67bb1  IBMPlexSans-SemiBold.ttf
7c6fbddca4b700be918f5f6183d9bd4464fa427fe435f0b480d77fe2bb8c5a43  IBMPlexMono-Regular.ttf
```

Покрытие кириллицы проверено по таблице `cmap`: во всех пяти файлах есть весь диапазон
U+0410…U+044F, а также «Ё» (U+0401), «ё» (U+0451) и «№» (U+2116). Слово «Кузьмич» отрисуется
каждым из них.

Имя `RussoOne-Regular.ttf` менять нельзя: на этот путь ссылается брендирование инсталлятора
(волна 6, задача A6 в `docs/KUZMICH_PLAN.md`).
