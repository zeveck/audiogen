# Changelog

audiogen uses the release date as its version: `vYYYY.M.D` (for example
`v2026.10.11`). A second release on the same day adds `.2`, a third `.3`, and
so on (`v2026.10.11.2`).

The running version is shown by `--help` and `--version`, and recorded as
`audiogenVersion` in every `.audiogen-history.jsonl` entry.

## v2026.10.31

- audiogen no longer assumes the free ElevenLabs plan. A new `plan`
  subcommand reads the account's plan (`GET /v1/user/subscription`) and
  says whether audio must credit ElevenLabs. The skill checks it before
  generating and asks for the credit only on the free plan, where it also
  uses the 64 kbps format free accounts are limited to. When the key
  can't read the plan, the first generation settles it: the default
  `mp3_44100_128` working means a paid plan.
- Tests run as CommonJS wherever the repo is cloned, including inside a
  folder whose `package.json` sets `"type": "module"`.

## v2026.10.11

First versioned release. Generation behavior, flags, and defaults are
unchanged, except for `.env` loading: the CLI now loads every `.env` in the
current directory and its parents, then in its own folder and its parents,
nearest first, and a file never overrides a variable that is already set. A
project's `.env` is found from any subfolder even when the CLI runs from a
plugin install, and an unrelated parent `.env` can't hide a key set in a
nearer one. Previously only the first `.env` found was loaded.

- audiogen is now a Claude Code plugin with its own marketplace:
  `/plugin install audiogen --marketplace zeveck/audiogen`. Installed copies
  update with `claude plugin update audiogen@audiogen`. The plugin is rooted
  at `skills/`, so an install copies only the skill, not the repository.
- The skill moved from `.claude/skills/audiogen/` to `skills/audiogen/`, and
  its `SKILL.md` runs the bundled CLI through `${CLAUDE_SKILL_DIR}`, so it works
  from a plugin install or a copied folder. Links to the old
  `.claude/skills/audiogen` folder no longer resolve; the manual install
  instructions in the README use the new path.
- New `--version` flag prints just the version, `--help` shows it in its first
  line, and each history entry carries an `audiogenVersion` field.
- Dev container refreshed to the shared zeveck template (agent history,
  memory, settings, and plugins kept across rebuilds but not sign-ins, GitLab
  CLI, `auth`/`dc` helpers, Chromium-based Playwright setup).
  Generated or personal files (`.playwright/`, `.claude/skills/playwright-cli/`,
  `.claude/settings.local.json`) are no longer tracked.
- Tests now check that the CLI version, plugin manifest, and this changelog
  agree, and the skill-structure test parses the quoted `allowed-tools`
  front matter that was already in `SKILL.md` (it previously failed on it).

## Before v2026.10.11 — unversioned releases installed by copying the skill folder

Earlier releases had no version number and were installed by copying
`.claude/skills/audiogen/` into a project.
