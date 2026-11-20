# Security

This toolkit is used on live WordPress sites, with a coding assistant helping inside strict limits, so its safety checks matter.
If you find a way around them, please tell me privately before sharing it publicly.

## Reporting a problem

Use **GitHub private vulnerability reporting**: open the **Security** tab of this repository and click **Report a vulnerability**.
Only you and I will see the report.

Please include what you did, what happened and what you expected, and the template version (`.claude/template/manifest.json` → `version`).
I will reply within a few days and keep you updated until it is fixed.

Please do not open a public issue for security problems.

## What counts

Examples of what I would like to hear about:

- the assistant can edit files outside the project's own theme and plugins, or edit WordPress core, other plugins, hooks or settings;
- a destructive server or database command runs without confirmation, or without the automatic database backup first;
- the assistant can write files on the server or connect to it bypassing the template's scripts;
- passwords or keys can end up in chat, logs, commits or anywhere outside the project's private config;
- the automatic rollback after a broken change fails silently;
- a downloaded third-party skill gets enabled although its hash does not match the pinned version, or a dangerous change slips past the content check.

Problems inside third-party skills belong to their own projects (see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)),
but a note here is welcome too.

## Supported versions

Only the latest version on the `main` branch is supported. Projects get fixes through the template update script.

## Keeping your own projects safe

- A project made from this template stores server access details in `ACCESS.md` and `.vscode/*.json`.
  **Its repository must be private.** The session start check warns if it is public.
- Never commit SSH keys or `.env` files; the template's `.gitignore` blocks them, keep it that way.
- Give the assistant its own WordPress user, and on production prefer an Editor role; sign in to production yourself when an admin is needed.
- Hooks and `.claude/settings.json` are the safety layer: change them only by hand, and run `node .claude/hooks/selftest.mjs` afterwards.
