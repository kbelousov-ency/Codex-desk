# Кнопка «+»: изображения и другие файлы — 2026-09-19

Пользователь указал, что «+» только для изображений дублирует Ctrl+V, и разрешил либо убрать кнопку, либо расширить её. Выбран второй вариант: одна кнопка «Добавить файлы» открывает нативный multi-select для всех файлов. Прежнее поведение images-only не удалено из истории решений; Ctrl+V/drag изображений продолжают работать.

## Поведение

- PNG/JPEG/WebP/GIF добавляются как прежние image previews; максимум 10 в сообщении, по 20 МиБ, суммарно 60 МиБ. ImageSlots учитывает уже прикреплённые изображения. Unsupported image formats (например SVG/AVIF) передаются путями.
- PDF, текст, исходники, Office-документы, архивы и другие обычные локальные файлы добавляются абсолютными путями отдельными строками в composer. Сам файл не копируется и его содержимое при выборе не читается/не отправляется. Пользователь может удалить строку/дописать вопрос; Codex получает ровно видимый текст после обычной отправки, уточнения или очереди.
- Поддержка анализа PDF/архива/документа зависит от инструментов и доступа Codex, не обещается собственный парсер всех форматов. При перемещении/изменении файла ссылка ведёт к текущему состоянию диска, snapshot документа не создаётся. Выбор файла вне проекта возможен; действие не меняет sandbox/права Codex.
- До 20 файлов за один выбор. Повторные канонические пути в одном выборе дедуплицируются. Отмена ничего не меняет, ошибка/превышение лимита отвергает весь пакет без частичного добавления. Если модель не принимает изображения, «+» остаётся доступным и все выбранные изображения становятся путями с пояснением.
- Выбор не отправляет модельный запрос. Во время picker блокируются отправка/очередь/autoping и Nightly prepare; набранный за это время текст сохраняется, пути добавляются в его конец. Переход к другой вкладке/cwd/thread или отмена редактирования инвалидируют старый результат. Простая смена фокуса на native picker не инвалидирует выбор.

## Код и проверки

`electron/composer-files.mjs` принимает только native-selected paths из host. `chooseComposerFiles({imageSlots,imagesSupported})` — scoped IPC; путь из renderer в параметры не принимается. Проверяются обычный локальный файл, realpath, существование, доступ, управляющие символы, Windows devices/ADS/UNC. Явно выбранные ссылки канонизируются до локального файла. Картинки читаются через bounded FileHandle/stat и проверку сигнатуры; изменение при чтении отменяет результат. Все остальные типы возвращаются без чтения содержимого.

`src/App.tsx` держит picker generation и pending ref, добавляет paths в текст и images в attachments. Текущие preview/черновик/редактируемое сообщение сохраняются; старый скрытый image input остаётся для «Показать идею», Ctrl+V и регрессий. Tooltip «Добавить файлы: изображения с превью, остальные — путями в сообщение» отражает семантику.

`tests/composer-files.test.mjs` — смешанные файлы/Unicode, типы/сигнатуры, slots/20/60 МиБ, unknown image, paths/dedup/links и stale чтение. `scripts/ui-composer-files.mjs` — production renderer/fake bridge: cancel/error, mixed selection, literal paths, точная явная отправка, async typing/double click, busy queue, stale вкладка/thread/cwd, текстовая модель и Ctrl+V. `scripts/ui-composer-files-host.mjs` — настоящий Electron/preload/IPC, fake native dialog: scoped cwd и строгие параметры, смешанный выбор, неизменность исходных файлов, duplicate picker/stale session. Настоящих model calls/открытия EXE или документов нет.

Поставка Nightly `cbf7789318526f433cb03ebd3f300f7f07ff7a4b3184f13f0db5f0fdee68b92e`: 22 targeted backend/preload tests passed; composer-files, edit-message, composer-layout, message-queue, nightly-restore, workspace-state прошли. Готовый кандидат прошёл native picker IPC (`artifacts/composer-files-host-xJps4k`), queue/steer (`artifacts/message-queue-host-AGfk1E`), identity (`artifacts/app-identity-kXFdCY`) и bootstrap Codex (6 моделей, прежние Astra/Ultra, без model turn). 72 файла манифеста и изменённые host/renderer байты проверены. Release app.asar не менялся; кандидат ожидает штатного закрытия Nightly.
