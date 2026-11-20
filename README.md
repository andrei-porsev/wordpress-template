# WordPress development and maintenance toolkit

[![Tests](https://github.com/andrei-porsev/wordpress-template/actions/workflows/tests.yml/badge.svg)](https://github.com/andrei-porsev/wordpress-template/actions/workflows/tests.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

This is the toolkit I use to build and maintain WordPress sites for my clients — business websites, online stores,
blogs and multilingual sites.

I plan the work, make the decisions and review every result. Routine parts — searching the code, repetitive edits,
checks on different screen sizes, uploads — are sped up by a coding assistant ([Claude Code](https://claude.com/claude-code)),
the same way a developer uses an IDE or build tools. The toolkit sets strict limits on what the assistant may touch and puts every
change through automatic safety checks, so the speed never comes at the cost of a live site.

## What it means for your site

- **Your live site stays up.** Every change is checked before and after it goes online. If something breaks, the previous version
  comes back automatically within seconds.
- **Changes can go to a test copy first.** Bigger work is done and reviewed on a private staging copy of your site, and goes live
  in one step when it is ready.
- **Nothing outside the job is touched.** Work happens only in the site's own theme and plugins. WordPress itself,
  third-party plugins, server files and passwords are off-limits for the tools — this is enforced, not just promised.
- **Your data is protected.** Before any change to the database, a backup is made automatically. Risky commands are blocked.
- **The site looks right on every screen.** Each visual change is checked in a real browser on phone, tablet and desktop sizes,
  with before/after screenshots. Before handover, a full quality check covers layouts, browsers, the design mockup, texts,
  languages, forms, accessibility and speed.
- **Nothing gets lost between sessions.** Access details, decisions and the site's design rules are written down in the project,
  so work continues where it stopped — no repeated questions, no guessing.
- **You choose the languages.** Project notes, code comments and change history can be kept in English, Ukrainian, Russian
  or any other language.

## How a typical change works

1. You describe the task; I agree with you what will change and how.
2. For anything noticeable, I write down a short plan first — what, where and in what order it goes live.
3. The change is made on a local copy of the code, never directly on the server.
4. Automatic checks run, and the change is published — to the live site or to the test copy, as agreed.
5. I check the result in a browser on phone, tablet and desktop sizes and send you a short report with screenshots.
6. Every step is saved in the project history, so any change can be traced and undone.

## Starting a new project

At the start I go through a short setup: what kind of project it is (new site, redesign, support, move to a new host,
SEO and speed), a brief about your business, server access, and a security check of an existing site before anything is downloaded.
The result is a project profile, so the work stays consistent from the first task to the last.

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
- Agent skills are enabled per stack (FSE, classic, WooCommerce, ACF, blocks, SEO, animation, design). Third-party skills are not stored here:
  each project downloads a reviewed, pinned version from upstream, verifies its hash and scans it before use.
- `template-update.mjs` updates a project with a three-way merge, migrations and a rollback tag.

| Path | What it is |
|------|------------|
| `CLAUDE.md` | Core rules loaded into every agent session |
| `.claude/rules/`, `.claude/rules-optional/` | Coding, layout, safety and operations rules |
| `.claude/hooks/` | Guard and deploy hooks with a self-test (`selftest.mjs`) |
| `.claude/skills/` | Core skills: `project-init`, `project-ops`, `project-structure`, `qa`, `howto`, `markup` |
| `.claude/skills.json` | Skill stacks and pinned third-party skill versions — see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) |
| `.claude/skills-optional/` | The template's own optional skills (WooCommerce, ACF, classic theme, page builders) |
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
