# WordPress project template for Claude Code

[![Tests](https://github.com/andrei-porsev/wordpress-template/actions/workflows/tests.yml/badge.svg)](https://github.com/andrei-porsev/wordpress-template/actions/workflows/tests.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A working setup for maintaining and building **live WordPress sites with an AI agent** ([Claude Code](https://claude.com/claude-code)) —
safely. The agent edits theme and plugin code locally, every change is linted, backed up, uploaded, checked on the site and rolled back
automatically if something breaks. Server access, deploys and database changes go through guarded scripts, not free-form shell commands.

I use it every day on client sites (classic themes, block/FSE themes, page builders, WooCommerce). The template is updated in the open:
each improvement is recorded as a decision with its reasoning and shipped to existing projects by an update script.

> The template's own rules and docs are in Russian (the language I work in). For each project you choose the language of its documentation,
> code comments and commit messages (English, Ukrainian, Russian or any other); the agent talks to you in the language set in Claude Code.

## What it does

- **Guarded deploys.** After every edit a hook runs `php -l`, saves the server copy, uploads the file over SFTP, checks the home page and
  `debug.log`, and rolls back on a fatal error. Modes: auto-deploy to production, to a staging site, manual, or local copy only.
- **Hard boundaries for the agent.** Hooks block edits outside the project's own theme/plugins, writes to WordPress core and third-party
  plugins, direct `ssh`/`scp`, file writes on the server, and secret files. Agent settings and hooks can only be changed by a human.
- **Safe WP-CLI.** Commands are parsed before they run: read-only ones pass, changing ones ask for confirmation after an automatic
  database dump (stored outside the web root, `chmod 600`), destructive ones are blocked.
- **Session start check.** Uncommitted work, server files changed by someone else, WordPress/plugin version changes, a quick integrity
  check of core files and `uploads/`, a warning if a project repository with credentials is public.
- **Project onboarding.** A guided start for 7 project types (new site with or without design, support, redesign, migration, SEO and speed):
  brief, server access, a security check before downloading anything, stack, services, environments — one summary, then setup.
- **Layout quality.** BEM + SCSS starter, fluid type and spacing, a design passport for each site, mandatory browser checks at all
  breakpoints (Playwright), before/after screenshot diffs, and a full QA pass (`/qa`): responsive, cross-browser, pixel-perfect against Figma,
  content vs. design, languages, states, accessibility, launch checklist, regression after updates.
- **Skill stacks.** Only the agent skills a project needs are enabled (FSE, classic, WooCommerce, ACF, Gutenberg blocks, SEO, animation, design…),
  each pinned to an upstream commit with a content hash and updated only after review.
- **Template updates for live projects.** `template-update.mjs` brings a project to the latest template version with a three-way merge,
  conflict report, migrations and a rollback tag; the project's own edits are kept.
- **Decisions that stay readable.** Every rule has a recorded reason. One topic — one record: changes rewrite the record in place
  instead of piling up "amends #12" chains, and a check at session start flags chains, stale entries and dead links.

## How it works

```
You ──► Claude Code ──► Edit / Write in your theme or plugin (local files only)
                           │
                           ├─ guard hooks: allowed paths? allowed command? no secrets?
                           └─ post-edit hook: php -l → lint → backup server copy → SFTP upload
                                              → check site + debug.log → roll back on error
Server ◄── only through scripts: sftp-sync.mjs (upload / sync / deploy), ssh-exec.mjs (WP-CLI, read-only by default)
```

## Repository layout

| Path | What it is |
|------|------------|
| `CLAUDE.md` | Core rules loaded into every agent session |
| `.claude/rules/` | Coding, layout, safety and operations rules (`rules-optional/` — per stack) |
| `.claude/hooks/` | Guard and deploy hooks with a self-test (`selftest.mjs`) |
| `.claude/skills/` | Core skills: `project-init`, `project-ops`, `project-structure`, `qa`, `howto`, `markup` |
| `.claude/skills/project-ops/scripts/` | SFTP/SSH, deploy, SCSS build, browser, screenshot diff, skills sync, template update |
| `.claude/skills-optional/` | Third-party skills by stack — see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) |
| `.claude/template/` | Template decisions log, version manifest, migrations |
| `project-base/` | Project map, workflow, SCSS starter, templates for the design passport, content types and QA |
| `ACCESS.md`, `.vscode/` | Per-project access and editor/SFTP config (empty in the template) |

## Getting started

Requirements: [Claude Code](https://claude.com/claude-code), Node.js 22, Git. Optional: PHP (for `php -l`), Composer + PHPCS (WordPress
Coding Standards), WP-CLI on the server. Developed and tested on Windows (PowerShell / Git Bash); scripts are plain Node.js.

1. Create a **private** repository from this template (it will hold server credentials) and clone it.
2. Install script dependencies: `npm install` in `.claude/skills/project-ops/`.
3. Open the folder in Claude Code and say **"старт проекта"** ("start project") — the `project-init` skill walks through the setup.

Run the tests: `node .claude/skills/project-ops/tests/test-<name>.mjs` and `node .claude/hooks/selftest.mjs`.

## Status

Actively developed and used in production on client sites. Changes and their reasons: `.claude/template/DECISIONS.md` and the commit history.

## License

MIT for the template's own code and documentation — see [LICENSE](LICENSE). Third-party agent skills keep their own licenses —
see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Author: Andrei Porsev, WordPress developer.
