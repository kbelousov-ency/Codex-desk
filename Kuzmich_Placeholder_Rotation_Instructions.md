# Kuzmich --- Chat Placeholder Rotation Instructions

## Goal

Implement a rotating placeholder in the chat input that gives
**Кузьмич** a consistent personality: an experienced engineering-minded
coordinator with dry humor. The phrases should feel useful and
occasional---not like a joke generator.

Use the existing UI and code architecture. Preserve all current
functionality and styling. Follow `Kuzmich_Design_System.md` for visual
styling.

## When to show phrases

Maintain two strictly separate phrase libraries:

1.  **New project** --- use only when the user opens or creates a new
    project.
2.  **Continuing work** --- use only when the user returns to or
    continues an existing project/session.

Never mix the libraries. If the application already has a reliable way
to determine whether a project/session is new or existing, use it. Do
not infer this from the placeholder text itself.

Show or select a new phrase when the application opens or a new
session/project is initialized, according to the existing lifecycle. Do
**not** change the phrase every time the input gains focus, loses focus,
or rerenders.

## Frequency tiers

For each library, choose a tier first, then choose a phrase uniformly at
random from that tier:

-   **Often --- 50%:** practical, broadly applicable phrases.
-   **Sometimes --- 35%:** more personality and light humor.
-   **Rarely --- 15%:** more distinctive or playful phrases.

These percentages apply to tier selection, not to each phrase
individually. Every phrase within a selected tier should have equal
probability unless the existing application has a documented alternative
convention.

## Anti-repetition

-   Avoid showing the same phrase twice in a row.
-   If practical, avoid any phrase shown in the previous 5 selections.
-   Keep the implementation simple; do not add persistence or
    dependencies solely for this feature.
-   If a tier is empty or unavailable, fall back to a non-empty tier in
    the same library. Never fall back to the other library.
-   Keep the placeholder concise and ensure it does not obscure the
    input's purpose.

## Phrase library: New project

### Often --- 50%

-   «Так, какую задачу сегодня победим?»
-   «Давай вводные, остальное разберём.»
-   «Ну-с, куда копаем?»
-   «Ставь задачу, чай сам себя не автоматизирует.»
-   «Давай по порядку, не всё сразу.»
-   «Задача ясна? Сейчас проверим.»
-   «Вводные на стол, начинаем думать.»
-   «Давай задачу. Магии не обещаю, результат постараюсь.»
-   «Пиши, что задумал. Попробуем не усложнять.»
-   «Так, включаем голову. Остальное у нас автоматизировано.»

### Sometimes --- 35%

-   «Излагай. Посмотрим, что можно сделать.»
-   «Чего изволите от цифрового мастера?»
-   «Ну, выкладывай свои соображения.»
-   «Ну что, поработаем головой.»
-   «Давай посмотрим, что тут можно улучшить.»
-   «Что-то строим или что-то спасаем?»
-   «Кого сегодня запрягаем?»
-   «Есть работа --- найду, кому поручить.»
-   «Давай задачу. По исполнителям раскидаю.»
-   «Ну, удиви меня. Только по делу.»
-   «Ну, командуй. Я человек подневольный, цифровой.»
-   «Задачу давай. Не зря же я тут солидный.»
-   «Давай исходники, а не предчувствия.»
-   «Не обещаю чудес. Но инструменты у нас приличные.»
-   «Ну что, мастерская открыта. Где болит?»

### Rarely --- 15%

-   «Рассказывай. Я пока кофе мысленно налью.»
-   «Ну, командуй. Только ТЗ не на салфетке.»
-   «Сейчас организуем этот маленький цифровой цех.»
-   «Давай сделаем нормально. Переделывать я не люблю.»
-   «Работаем. А там посмотрим, кто кого.»
-   «Ну, что у нас тут опять?»
-   «Так, с чем будем разбираться?»

## Phrase library: Continuing work

### Often --- 50%

-   «Рассказывай, что сломалось. Или что улучшаем.»
-   «Показывай фронт работ. Без паники, разберёмся.»
-   «Так, показывай, что там у тебя.»
-   «Слушаю внимательно. Пока что.»
-   «Так, с чем будем разбираться?»
-   «Сложность вижу. Повода для паники пока нет.»
-   «Показывай проблему. Авось не первая такая.»
-   «Так, кто виноват --- потом. Что делать --- сейчас.»
-   «Сначала рабочий вариант, потом будем гордиться.»
-   «Всё решаемо. Вопрос только --- сколько там сюрпризов.»
-   «Ладно, поехали. Само себя не починит.»
-   «Работаем по уму. По-другому я не умею.»

### Sometimes --- 35%

-   «Давай задачу. Остальное разберём.»
-   «ТЗ есть или будем по симптомам лечить?»
-   «Показывай чертёж. На глаз мы уже делали.»
-   «Сначала разберёмся, потом нажмём красную кнопку.»
-   «Ничего не трогаем. Сначала смотрим, что уже натворили.»
-   «Ну, где тут собака зарыта?»
-   «Ошибки не страшны. Страшно, когда их не логируют.»
-   «Сколько агентов --- столько и мнений. Разберёмся.»
-   «Один думает, второй проверяет. А мы проконтролируем.»
-   «Каждому своё. И никаких собраний на три часа.»
-   «Сейчас разложим по полочкам. Если полочек хватит.»
-   «Ну что, опять будем делать красиво вместо быстро?»
-   «Давай сделаем нормально. Переделывать я не люблю.»
-   «Давай по порядку, не всё сразу.»
-   «Пиши, что задумал. Попробуем не усложнять.»

### Rarely --- 15%

-   «Опять автоматизируем то, что вчера автоматизировали?»
-   «Сначала рабочий вариант, потом будем гордиться.»
-   «Давай без фокусов. Хотя бы в этот раз.»
-   «Что на этот раз придумали светлые головы?»
-   «Все при деле? Отлично. Теперь пусть работают.»
-   «Я тут за порядком. Ну и за результатом.»
-   «Сколько агентов --- столько и мнений. Разберёмся.»
-   «Работаем. А там посмотрим, кто кого.»
-   «Ну, удиви меня. Только по делу.»
-   «Рассказывай. Я пока кофе мысленно налью.»
-   «Задачу давай. Не зря же я тут солидный.»
-   «Ну, командуй. Я человек подневольный, цифровой.»

## Implementation notes

1.  Keep the phrase libraries in one clearly named module or data
    structure, separated by context and frequency tier.
2.  Use the project's existing language conventions, state management,
    and lifecycle hooks.
3.  Do not add a new library or framework for random selection.
4.  If there is already a placeholder or localization system, extend it
    rather than creating a parallel one.
5.  Keep the selected phrase as placeholder/help text only. It must not
    become an actual message, default input value, or submitted prompt.
6.  Do not modify the input's buttons, model selection, queue controls,
    or other adjacent UI while implementing this feature.
7.  Keep the existing design-system palette and typography. Do not
    introduce orange accents, neon gradients, or decorative animations.

## Acceptance checklist

-   [ ] New project/session uses only the **New project** library.
-   [ ] Existing project/session uses only the **Continuing work**
    library.
-   [ ] Tier selection follows 50% / 35% / 15%.
-   [ ] A phrase is chosen uniformly within the selected tier.
-   [ ] The phrase does not change on input focus/blur or incidental
    rerenders.
-   [ ] The last phrase is never repeated consecutively; avoid the
    previous 5 when practical.
-   [ ] If a tier is empty, fallback stays within the same library.
-   [ ] Placeholder text never enters the actual user prompt.
-   [ ] Existing input behavior and adjacent controls remain unchanged.
-   [ ] No new dependencies are introduced without a clear need.

## Short instruction for the coding agent

Implement this feature with minimal, targeted changes. First inspect how
the application distinguishes new projects from existing sessions and
how the chat placeholder is currently assigned. Then implement the two
separate phrase libraries and weighted tier selection, test both paths,
and report the files changed and verification performed. Do not refactor
unrelated code.
