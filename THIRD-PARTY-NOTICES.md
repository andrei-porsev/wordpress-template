# Third-party notices

The template's own code and documentation are licensed under the MIT License (see [LICENSE](LICENSE)).

## Third-party skills

Third-party agent skills are **not stored in this repository**. `.claude/skills.json` only records where each skill comes from
and a reviewed version (commit and content hash). When a project enables a stack, `.claude/skills/project-ops/scripts/skills-sync.mjs`
downloads exactly that version from the upstream repository, verifies the hash and checks the content before use.
Each skill stays under its own license, as published by its authors:

| Skills | Source | License |
|--------|--------|---------|
| `wp-block-development`, `wp-block-themes`, `wp-interactivity-api`, `wp-patterns`, `wp-performance`, `wp-phpstan`, `wp-playground`, `wp-plugin-development`, `wp-rest-api`, `wp-wpcli-and-ops`, `wordpress-router`, `wp-project-triage`, `blueprint` | [WordPress/agent-skills](https://github.com/WordPress/agent-skills) | GPL-2.0-or-later |
| `woocommerce-performance` | [woocommerce/woocommerce](https://github.com/woocommerce/woocommerce) | GPL-2.0-or-later |
| `site-architecture`, `content-strategy`, `copywriting`, `copy-editing`, `cro` | [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills) | MIT |
| `accessibility`, `core-web-vitals` | [addyosmani/web-quality-skills](https://github.com/addyosmani/web-quality-skills) | MIT |
| `frontend-design` | [anthropics/skills](https://github.com/anthropics/skills) | Apache-2.0 |
| `gsap-core`, `gsap-timeline`, `gsap-scrolltrigger`, `gsap-plugins`, `gsap-utils`, `gsap-performance` | [greensock/gsap-skills](https://github.com/greensock/gsap-skills) | MIT |
| `ui-ux-pro-max` | [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | MIT |
| `impeccable` | [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | Apache-2.0 |
| `semantic-html` | [schalkneethling/claude-toolkit](https://github.com/schalkneethling/claude-toolkit) | MIT |
| `good-css` | [vojtaholik/good-css](https://github.com/vojtaholik/good-css) | MIT |
| `humanizer` | [blader/humanizer](https://github.com/blader/humanizer) | MIT |
| `figma-use`, `figma-generate-design`, `figma-generate-library`, `figma-create-new-file`, `figma-design-to-code` | [figma/mcp-server-guide](https://github.com/figma/mcp-server-guide) | no open-source license — [Figma Developer Terms](https://www.figma.com/legal/developer-terms/) |

The skills `woocommerce`, `acf-blocks`, `classic-theme` and `page-builders` in `.claude/skills-optional/` are part of this repository (MIT).

## GSAP library

The `gsap-*` skills are MIT. The GSAP library itself, which a theme may bundle locally, is distributed under the
[GreenSock Standard No-Charge License](https://gsap.com/standard-license/).
