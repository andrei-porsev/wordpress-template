# Stage: создание, «безопасный stage», пароль, переход в прод

Stage — копия сайта для правок до прода. У клиента (встроенный staging хостинга) или на своём VPS (`~/.wp-template/servers.json`).
Копию существующего сайта — **только после проверки безопасности** (`project-init` → `recon.md`): заражённое на свой сервер не переносим.

## 1. Создать

| Где | Кто | Как |
|-----|-----|-----|
| Свой VPS (Plesk) | человек | подписка на проект по плану «Stage» → WP Toolkit → Clone (с того же сервера), Import (с хостинга клиента) или Install (нового сайта ещё нет) — по шагам [plesk.md](plesk.md) |
| Хостинг клиента | человек | встроенный staging (SiteGround, Kinsta, WP Engine, Cloudways…) — в панели хостинга |

Конфиги: свой VPS — `stage-config.mjs build <project>` (план) → «да» → `--yes`; хостинг клиента — данные как для прода → `.vscode/sftp-stage.json`, `ssh-stage.json`.
Проверка — `connect-check.mjs --stage`. `ACCESS.md` → «Окружения», `Stage / dev URL`.

## 2. «Безопасный stage» — сразу после создания

Изменения — через WP-CLI после «да» (`ssh-exec.mjs --stage -- wp …`, хук сделает дамп); без WP-CLI — человек в админке по этим же пунктам.

| Что | Как | Зачем |
|-----|-----|-------|
| Запрет индексации | `wp option update blog_public 0`; заголовок `X-Robots-Tag: noindex` — панель / веб-сервер (человек) | копия не попадёт в Google как дубль |
| Пароль на весь stage | Plesk → Password-protected directories (человек), свой у каждого проекта; логин и пароль → `httpAuth` в `sftp-stage.json` | посторонние не видят незапущенный сайт; клиент смотрит работу |
| Перехват почты | плагин-заглушка (Disable Emails или аналог): `wp plugin install disable-emails --activate` после «да» | формы и Woo не пишут реальным клиентам |
| Тестовые ключи оплаты | WooCommerce → Платежи — человек (ключи — секреты) | никаких реальных списаний |
| Внешние cron-задачи | `wp cron event list`; рассылки и синхронизации с CRM — отключить после решения пользователя | копия не дублирует действия прода |
| Домен в базе | `wp search-replace '<прод>' '<stage>' --dry-run`, затем без `--dry-run` после «да» | ссылки ведут на stage |

Каждый ручной пункт — блоком «🖐 Сделать вручную» (`project-init` → `manual-steps.md`).

## 3. Пароль stage для скриптов и браузера

Пароль на каталог у каждого проекта свой: хранится только в `sftp-stage.json` → `httpAuth`, в `ACCESS.md` — где лежит и выдан ли клиенту.

- **Скрипты** (`deploy`, `recon`, `session-check`): `httpAuth: { "user", "password" }` в `sftp-stage.json` — иначе проверка сайта видит только HTTP 401. Повторный `stage-config build` его не затирает.
- **Браузер агента:** `stage-config.mjs auth <project>` (или `build`, если `httpAuth` уже вписан) пишет `.vscode/playwright-mcp.json` — `httpCredentials` только для origin stage (пароль не уходит на другие сайты и не попадает в адрес).
  Подключить: `.mcp.json` → playwright → `args` + `"--config", ".vscode/playwright-mcp.json"` (агент после «да»), затем `/mcp` → переподключить playwright (человек).
  Без профиля — тот же файл вручную:

  ```json
  { "browser": { "contextOptions": { "httpCredentials": { "username": "…", "password": "…", "origin": "https://<stage>" } } } }
  ```

  Не сработало (окно ввода пароля в браузере) — человек вводит пароль в окне браузера сам; агент пароль в поля не вводит.

## 4. Stage → прод

- Код — `sftp-sync.mjs deploy` (`sftp.md`).
- Весь сайт / БД (запуск редизайна, новый сайт) — WP Toolkit «Синхронизировать» или плагин миграции, человек, перед этим бэкап прода; затем на проде — индексация открыта, почта и ключи оплаты боевые (человек).
- Переезд: stage был новым сервером → `stage-config.mjs promote` (`project-init` → `types.md` → «Переезд»).

## 5. Stage больше не нужен

Свой VPS — [plesk.md](plesk.md) → «Конец проекта»: проверка, что всё на проде, удаление подписки человеком, `ACCESS.md` → «Stage: удалён <дата>», смена режима `stage-auto`; конфиги в `.vscode/` остаются.
Stage у клиента — то же, удаляет клиент или человек в панели хостинга.
