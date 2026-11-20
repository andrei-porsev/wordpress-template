# WordPress project template for Claude Code

[![Tests](https://github.com/andrei-porsev/wordpress-template/actions/workflows/tests.yml/badge.svg)](https://github.com/andrei-porsev/wordpress-template/actions/workflows/tests.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

This is how I build and maintain WordPress sites with an AI assistant ([Claude Code](https://claude.com/claude-code)) —
fast, but without putting a live site at risk.

An AI assistant can write code quickly, but on a real website speed alone is not enough: one careless change can take the site down,
touch the wrong files or lose someone else's work. This template gives the assistant clear rules, safety checks and a fixed way of working,
so every change is careful, checked and easy to undo.

I use it every day on client sites — business websites, online stores, blogs and multilingual sites.

## What it means for your site

- **Your live site stays up.** Every change is checked before and after it goes online. If something breaks, the previous version
  comes back automatically within seconds.
- **Changes can go to a test copy first.** Bigger work is done and reviewed on a private staging copy of your site, and goes live
  in one step when it is ready.
- **Nothing outside the job is touched.** The assistant works only on the site's own theme and plugins. WordPress itself,
  third-party plugins, server files and passwords are off-limits — this is enforced, not just promised.
- **Your data is protected.** Before any change to the database, a backup is made automatically. Risky commands are blocked.
- **The site looks right on every screen.** Each visual change is checked in a real browser on phone, tablet and desktop sizes,
  with before/after screenshots. Before handover, a full quality check covers layouts, browsers, the design mockup, texts,
  languages, forms, accessibility and speed.
- **Nothing gets lost between sessions.** Access details, decisions and the site's design rules are written down in the project,
  so work continues where it stopped — no repeated questions, no guessing.
- **You choose the languages.** Project notes, code comments and change history can be kept in English, Ukrainian, Russian
  or any other language.

## How a typical change works

1. You describe the task.
2. For anything noticeable, the assistant first shows a short plan and waits for your OK.
3. It makes the change on a local copy of the code.
4. The change is checked automatically and published — to the live site or to the test copy, as agreed.
5. The assistant opens the page in a browser, checks it on different screen sizes and reports back with screenshots.
6. Every step is saved in the project history, so any change can be traced and undone.

## Starting a new project

When a project starts, the template walks through a short setup: what kind of project it is (new site, redesign, support, move to
a new host, SEO and speed), a brief about the business, server access, and a security check of an existing site before anything
is downloaded. The result is a project profile that the assistant follows from then on.

## Always improving

The template is updated in the open. Every rule has a written reason, and improvements reach existing projects through a safe
update that keeps each site's own changes. The automated tests run on every update.

---

## For developers

The template's own rules and docs are in Russian (the language I work in). Code and scripts are plain Node.js.

**Under the hood:**

- Claude Code hooks guard paths, shell commands and remote WP-CLI; agent settings and hooks can only be changed by a human.
- After each edit: `php -l` → backup of the server copy → SFTP upload → home page and `debug.log` check → automatic rollback on error.
  Deploy modes: `guarded-auto` (production), `stage-auto` (staging), `manual`, `local`.
- WP-CLI runs only through a guarded script: reads pass, writes need confirmation after an automatic DB dump (outside the web root, `600`).
- Session start check: uncommitted work, files changed on the server by someone else, WordPress/plugin version changes,
  a quick core and `uploads/` integrity check.
- BEM + SCSS starter with fluid type and spacing, a per-site design passport, Playwright checks at all breakpoints,
  screenshot diffs, and a `/qa` skill (responsive, cross-browser, pixel-perfect vs. Figma, content, languages, states, a11y, launch checklist).
- Agent skills are enabled per stack (FSE, classic, WooCommerce, ACF, blocks, SEO, animation, design), pinned to upstream commits.
- `template-update.mjs` updates a project with a three-way merge, migrations and a rollback tag.

| Path | What it is |
|------|------------|
| `CLAUDE.md` | Core rules loaded into every agent session |
| `.claude/rules/`, `.claude/rules-optional/` | Coding, layout, safety and operations rules |
| `.claude/hooks/` | Guard and deploy hooks with a self-test (`selftest.mjs`) |
| `.claude/skills/` | Core skills: `project-init`, `project-ops`, `project-structure`, `qa`, `howto`, `markup` |
| `.claude/skills-optional/` | Third-party skills by stack — see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) |
| `.claude/template/` | Decisions log, version manifest, migrations |
| `project-base/` | Project map, workflow, SCSS starter, templates for the design passport, content types and QA |

**Getting started:** Claude Code, Node.js 22, Git (optional: PHP, PHPCS with WordPress Coding Standards, WP-CLI on the server).
Create a **private** repository from this template — it will hold server access details — run `npm install` in
`.claude/skills/project-ops/`, open the folder in Claude Code and say **«старт проекта»** ("start project").
Tests: `node .claude/hooks/selftest.mjs` and `node .claude/skills/project-ops/tests/test-<name>.mjs`.

## License

MIT for the template's own code and documentation — see [LICENSE](LICENSE). Third-party agent skills keep their own licenses —
see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Author: Andrei Porsev, WordPress developer.
