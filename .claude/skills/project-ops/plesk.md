# Stage на своём VPS (Plesk): план «Stage», подписка на проект, конец проекта

Свой VPS (IONOS + Plesk) — только stage и промежуточные копии. Адрес stage — `{project}.<домен stage>` (у пользователя — `stage.example.com`), DNS зоны обслуживает сам Plesk.
Всё в панели делает **человек**: доступа администратора Plesk у агента нет (решение 033). Агент ведёт по шагам — каждый шаг блоком «🖐 Сделать вручную» (`project-init` → `manual-steps.md`) — и проверяет результат.

Один проект — одна подписка: свой системный пользователь, своя БД, свой пароль на каталог; удаление подписки убирает всё сразу.

## 1. План «Stage» — один раз на сервер

Plesk → Service Plans → Add Plan, имя `Stage`. Названия вкладок зависят от версии Plesk — искать по смыслу.

| Где в плане | Значение | Зачем |
|-------------|----------|-------|
| Hosting Parameters → SSH | `/bin/bash`; Permissions → управление SSH — **выключено** (пользователь не меняет оболочку) | WP-CLI и `php` работают; в chroot их нет |
| Hosting Parameters → PHP | 8.3, FPM application served by **Apache** | версию под прод клиента меняют в подписке |
| Web Server (Apache & nginx) | nginx в режиме прокси (Proxy mode), статику отдаёт nginx | `.htaccess` работает, как на проде клиента (Apache / LiteSpeed); чистый nginx — только если прод на nginx, в подписке |
| Web Server → директивы nginx | `add_header X-Robots-Tag "noindex, nofollow" always;` | noindex для статики |
| Web Server → директивы Apache (HTTP и HTTPS) | `Header always set X-Robots-Tag "noindex, nofollow"` | noindex для страниц WP (их отдаёт Apache) |
| Mail | почтовая служба выключена | ящиков нет; письма WP глушит «безопасный stage» |
| SSL / Let's Encrypt | выпуск и продление автоматически (SSL It! → Keep secured) | https сразу; на каждую подписку свой сертификат, маска не нужна |
| WP Toolkit | включён; автообновления ядра, плагинов и тем — выключены | stage повторяет версии прода |
| Resources | диск ~10 ГБ, 1 БД, 1 системный пользователь, без доп. доменов и ящиков | stage не разрастается |
| Backup | плановый — выключен | перед изменениями через WP-CLI хук делает дамп; перед крупными операциями — снимок VPS у IONOS |

**Сервер, один раз:**

- Plesk откажет создать подписку `{project}.<домен stage>`, потому что домен stage принадлежит другой подписке → Tools & Settings → Security Policy → разрешить поддомены и подзоны в чужих доменах.
- PATH для PHP в каждой новой подписке — попробовать через шаблон виртуального хоста (Tools & Settings → Virtual Host Template): `.bashrc` в корне архива со строкой `export PATH=/opt/plesk/php/8.3/bin:$PATH`. На первой подписке проверить (`connect-check --stage`: `php` и `wp` в PATH); не сработало — шаг 4 в разделе 2 вручную.

## 2. Подписка на проект

Копию **существующего** сайта — только после проверки безопасности (`project-init` → `recon.md`): заражённое на свой сервер не переносим.

1. Plesk → Subscriptions → Add Subscription: домен `{project}.<домен stage>`, план «Stage», системный пользователь `{project}_dev`.
2. SSL It! — сертификат Let's Encrypt (если не выпустился сам).
3. Публичный ключ агента (один на все подписки, `~/.ssh/…ed25519.pub`) → подписка → SSH Keys или `~/.ssh/authorized_keys`. Пароль пользователя агенту не нужен.
4. PATH для PHP, если не пришёл из шаблона хоста: `~/.bashrc` → `export PATH=/opt/plesk/php/<версия>/bin:$PATH` (нет файла — создать, есть — строкой в начало).
5. WP Toolkit:
   - прод на этом же сервере → **Clone**;
   - прод на хостинге клиента → **Import** (Website Migration);
   - нового сайта ещё нет → **Install** WordPress.
6. Password-Protected Directories → `/`: логин и пароль **свои для проекта** (их получает клиент, чтобы смотреть работу).
7. Агент:
   - `stage-config.mjs build <project>` → план → «да» → `--yes` (`.vscode/sftp-stage.json`, `ssh-stage.json`);
   - пароль на каталог → `.vscode/sftp-stage.json` → `httpAuth { "user", "password" }`: вписывает человек или агент из сообщения пользователя (в ответах не повторять); затем `stage-config.mjs auth <project>` → `.vscode/playwright-mcp.json`;
   - `connect-check.mjs --stage` — ключ, путь к WP, `php` и `wp`; не прошло — таблица диагностики (`project-init` → `access.md`), не больше 2 попыток входа;
   - «безопасный stage» (`stage.md` → 2) через WP-CLI после «да»;
   - браузер: stage открывается, заголовок `X-Robots-Tag` есть и у главной, и у файла CSS;
   - `ACCESS.md` → «Окружения»: Stage — свой VPS, Stage / dev URL, «Пароль на stage: в `sftp-stage.json` → `httpAuth`, выдан клиенту — да / нет».

Пароль на каталог в `ACCESS.md` не пишется — только где лежит. Клиенту его передаёт человек.

## 3. Конец проекта

Stage либо остаётся (сопровождение, будущие доработки — перед новой задачей освежить с прода: WP Toolkit → Sync, затем «безопасный stage»), либо удаляется.

**Удалить:**

1. Агент проверяет, что ничего не потеряется: сайт работает на проде, последняя выкатка сделана, `session-check` — незалитого нет.
   Сделанное только в базе stage (страницы, настройки), чего нет на проде, — списком пользователю; решает он.
2. Человек удаляет подписку в Plesk — БД, файлы, пользователь и сертификат уходят вместе с ней.
3. Агент после «да»: `ACCESS.md` → «Stage: удалён <дата>»; режим `stage-auto` → `guarded-auto` или `manual` (`ACCESS.md` → «Заливка»); коммит.
   Конфиги `.vscode/sftp-stage.json`, `ssh-stage.json`, `playwright-mcp.json` **остаются** — при новом stage их обновит `stage-config build`.

Агент к удалённому stage не обращается (`--stage` не использует), пока в `ACCESS.md` не появится новый.

**Клиент вернулся:** новая подписка по разделу 2 с прода (Clone / Import), `stage-config build` обновит конфиги, новый пароль на каталог → `httpAuth` и `auth`. В git — код, документация, настройки агента и вся история; БД и медиатека — с прода.
