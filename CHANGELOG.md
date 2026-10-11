# Changelog

audiogen uses date-based versions: `vYYYY.M.D` (for example `v2026.10.11`),
which are also valid semver. For a second release on the same day, use the next
day's date rather than a `-1` suffix, because semver sorts `2026.10.11-1`
before `2026.10.11`.

The running version is shown by `--help` and `--version`, and recorded as
`audiogenVersion` in every `.audiogen-history.jsonl` entry.

## v2026.10.11

First versioned release. Generation behavior, flags, and defaults are
unchanged.

- audiogen is now a Claude Code plugin with its own marketplace:
  `/plugin install audiogen --marketplace zeveck/audiogen`. Installed copies
  update with `claude plugin update audiogen@audiogen`.
- The skill moved from `.claude/skills/audiogen/` to `skills/audiogen/`, and
  its `SKILL.md` runs the bundled CLI through `${CLAUDE_SKILL_DIR}`, so it works
  from a plugin install or a copied folder. Links to the old
  `.claude/skills/audiogen` folder no longer resolve; the manual install
  instructions in the README use the new path.
- New `--version` flag prints just the version, `--help` shows it in its first
  line, and each history entry carries an `audiogenVersion` field.
- Dev container refreshed to the shared zeveck template (persisted agent
  state, GitLab CLI, `auth`/`dc` helpers, Chromium-based Playwright setup).
  Generated or personal files (`.playwright/`, `.claude/skills/playwright-cli/`,
  `.claude/settings.local.json`) are no longer tracked.
- Tests now check that the CLI version, plugin manifest, and this changelog
  agree, and the skill-structure test accepts the quoted `allowed-tools`
  front matter that was already in `SKILL.md`.

## Before v2026.10.11 — unversioned releases installed by copying the skill folder

Earlier releases had no version number and were installed by copying
`.claude/skills/audiogen/` into a project.
