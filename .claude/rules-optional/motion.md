---
paths:
  - "**/assets/js/**"
  - "**/assets/lib/gsap/**"
  - "**/*.scss"
  - "**/functions.php"
  - "**/inc/**/*.php"
  - "**/patterns/**"
---

# Анимации (GSAP)

Скиллы `gsap-*` описывают API; это правило — как GSAP живёт в WP-теме (решение 024). При расхождении действует правило.

## CSS или GSAP

- Hover, focus, раскрытие, простое появление — CSS (`transition`, `@keyframes`).
- GSAP — таймлайн из нескольких шагов, ScrollTrigger (scrub, pin), SplitText, Flip, MorphSVG, DrawSVG.
- Скиллы GSAP советуют GSAP по любому поводу — не следовать: библиотека подключается, только если задача не решается CSS.
- Мера: один срежиссированный момент на страницу (загрузка hero или одна сцена при прокрутке). Fade-up на каждой секции и анимация каждой карточки — шаблон, не делать.

## Подключение

- Локальная копия в теме: `assets/lib/gsap/<версия>/` — `gsap.min.js`, только нужные плагины из `dist/` и файл лицензии пакета.
  Папка `lib/`, а не `vendor/`: `**/vendor/` исключён в `.gitignore` (Composer).
  Получить: `npm pack gsap@<версия>` во временную папку системы, распаковать, скопировать файлы; версию записать в `INDEX.md` → «Правила проекта». CDN не использовать.
- Регистрация в `functions.php` / `inc/` на `wp_enqueue_scripts` (только фронт, не редактор):
  - `wp_register_script( '{stem}-gsap', …, array(), '<версия>', array( 'strategy' => 'defer', 'in_footer' => true ) )`;
  - плагины — отдельные хэндлы с зависимостью от `{stem}-gsap`: `{stem}-gsap-scrolltrigger`, `{stem}-gsap-splittext`…;
  - свой код — `assets/js/{stem}-motion.js`, зависимости — только используемые хэндлы.
- Подключать только там, где есть анимация: `has_block()`, `is_front_page()`, `is_page_template()` или иное условие шаблона. Не на всех страницах сайта.
- `gsap.registerPlugin()` — один раз в `{stem}-motion.js`.

## Связь с разметкой

- Паттерны остаются статичными (`wp-patterns`: без JS). Анимацию навешивает `{stem}-motion.js` по признаку:
  - FSE — стиль блока через `register_block_style()`: `is-style-{stem}-reveal` и т. п.; редактор выбирает его в панели «Стили»;
  - classic / ACF — BEM-класс `{stem}-hero__title` или `data-{stem}-motion="reveal"`.
- Селекторы — через `gsap.utils.toArray()` по признаку, не по тегам и не по классам ядра.

## Доступность и надёжность

- Весь код — внутри `gsap.matchMedia()` с условием `(prefers-reduced-motion: no-preference)`; при `reduce` — контент сразу в конечном состоянии.
- Без JS контент видим: начальные состояния (`opacity: 0`, сдвиги) задаёт только GSAP, не CSS. Исключение — класс `{stem}-js` на `<html>`, который ставит скрипт.
- Элемент LCP (заголовок или картинка hero) не прятать за `opacity: 0` до загрузки скрипта.
- SplitText — `revert()` на брейкпоинтах через `matchMedia`; проверить, что текст читается скринридером целиком.
- ScrollTrigger: `ScrollTrigger.refresh()` после `load` и `document.fonts.ready`; `pin` — только на десктопных ширинах; `scrub` — небольшое число.
- ScrollSmoother и перехват скролла — только по прямой просьбе пользователя.
- Анимировать только `transform` и `opacity` (`x`, `y`, `scale`, `rotation`, `autoAlpha`); `width`, `top`, `margin` — нет.

## Проверка

Кроме `layout-check`:

- проверка переполнения — и в начальном состоянии анимаций (элементы со сдвигом по `x` дают горизонтальный скролл), и после прокрутки до конца;
- ScrollTrigger на 375 и 1440: триггеры срабатывают, pin не перекрывает контент;
- эмуляция `prefers-reduced-motion: reduce` (Playwright или DevTools): всё видно, ничего не двигается;
- консоль без ошибок GSAP; на страницах без анимаций библиотека не загружается (вкладка «Сеть»);
- CLS и LCP — стек `quality` (`core-web-vitals`).
