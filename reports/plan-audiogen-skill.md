# Plan Report — /audiogen ElevenLabs Game-Audio Generation Skill

## Phase — 2 Music generator

**Plan:** plans/audiogen-skill.md
**Status:** Landed
**Worktree:** /tmp/audiogen-cp-audiogen-skill-phase-2 (removed after land)
**Branch:** cp-audiogen-skill-2 (deleted after land)
**Commit (worktree):** dab80d4
**Commit (main):** 9238387

### Work Items

| # | Item | Status | Commit |
|---|------|--------|--------|
| 1 | `runMusic` hits `POST /v1/music` with `responseType: 'binary'` | Done | dab80d4 |
| 2 | `validateMusicOptions` — length range [3000,600000], wav_* reject, --loop reject | Done | dab80d4 |
| 3 | `buildMusicRequest` — URL + body `{prompt, music_length_ms, force_instrumental?, seed?}` | Done | dab80d4 |
| 4 | Default output `assets/audio/music/<slug>.mp3` with auto-versioning | Done | dab80d4 |
| 5 | History record: `phase:'music'`, prompt, length, optional seed/force_instrumental, format, path | Done | dab80d4 |
| 6 | Dry-run prints URL, body JSON, output path; skips network | Done | dab80d4 |
| 7 | `tests/music.test.js` — 27 unit tests (validation, body, dry-run, stub response paths, versioning) | Done | dab80d4 |

### Verification

- Unit suite: **77 pass / 0 fail** (`node --test tests/*.test.js`)
- Full gate: exit 0 (`bash scripts/test-all.sh`) — E2E + build still stub until Phase 6
- Architectural-lock spot-checks (5 items): all PASS
  - `callElevenLabs({ responseType: 'binary' })`, no content-type routing, validation pre-network, dry-run early-return, history writer guarded
- Acceptance criteria: 15/15 PASS
- Test-coverage spot-check: 3 tests inspected, real assertions (no todo/skip/ok-true placeholders)
- Verifier: fresh agent (sonnet), not the implementer

### Notes

- Impl agent discovered and worked around a node:test footgun: overriding `process.stdout.write` for capture clobbers the TAP reporter; injected a `deps.stdout` capture stream into `runMusic` instead. Only `process.stderr.write` + `process.exit` are overridden in test helpers. Documented in `tests/music.test.js` header.
- `execFileSync` stderr leak in Node 22 shows "#" comments in TAP output for CLI integration tests — cosmetic only, asserts still pass on `e.stderr`.

---

## Phase — 1 Scaffold & shared core

**Plan:** plans/audiogen-skill.md
**Status:** Landed
**Worktree:** /tmp/audiogen-cp-audiogen-skill-phase-1 (removed after land)
**Branch:** cp-audiogen-skill-1 (deleted after land)
**Commit (worktree):** 3c7265a
**Commit (main):** ed606e8

### Work Items

| # | Item | Status | Commit |
|---|------|--------|--------|
| 1 | `.claude/skills/audiogen/SKILL.md` with minimal frontmatter | Done | 3c7265a |
| 2 | `.claude/skills/audiogen/generate.cjs` with CLI grammar, env walker, HTTP retry, history writer, output resolver, slugify, routing stubs | Done | 3c7265a |
| 3 | Replace `{{UNIT_TEST_CMD}}` / `{{FULL_TEST_CMD}}` placeholders in `.claude/hooks/block-unsafe-project.sh` | Done | 3c7265a |
| 4 | Append `.audiogen-history.jsonl`, `.audiogen-voices.json`, `assets/audio/` to `.gitignore` | Done | 3c7265a |
| 5 | Set `testing.unit_cmd` in `.claude/zskills-config.json` | Done | 3c7265a |
| 6 | Unit test suite: `tests/{args,env,paths,history}.test.js` | Done (50 tests) | 3c7265a |
| 7 | Build-structure test: `tests/build/skill-structure.test.js` | Done | 3c7265a |

### Verification

- Unit suite: **50 pass / 0 fail** (`node --test tests/*.test.js`)
- Full gate: exit 0 (`bash scripts/test-all.sh`) — E2E + build suites skipped as expected (no dev server, no build prerequisite; Phase 6 wires these)
- Architectural-lock spot-checks (10 items): all PASS
  - Env walker mirrors imagegen (single-candidate cwd + `__dirname` walk-up, `return` on first success)
  - `callElevenLabs` branches on `response.ok`, not content-type
  - `responseType: 'binary' | 'json'` parameter present
  - Retry 3x on 429/500/502/503, `Retry-After` clamped 30s, 120s `AbortSignal`
  - 0-byte binary response → file removed, clear error
  - 422 + `output_format` in detail → free-tier hint
  - `appendHistory` accepts injectable `writeFn`; write failure does not abort generation
  - `resolveOutputPath` auto-versions to v999
  - Node floor guard for < 20.14
- Acceptance criteria: 15/15 PASS
- Verifier: fresh agent (sonnet), not the implementer

### Notes

- One test-case correction during implementation: `tests/paths.test.js` all-punctuation case was corrected to assert the timestamp fallback (spec-aligned), not the empty-string return. No source code changed for this.
- Ephemerals kept untracked: `.test-results.txt`, `.test-results-full.txt`, `.worktreepurpose`, `.zskills-tracked`.
- Hook placeholder `{{UI_FILE_PATTERNS}}` intentionally left in place (sentinel-guarded; no UI in this CLI-only project).
