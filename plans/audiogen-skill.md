---
title: /audiogen — ElevenLabs Game-Audio Generation Skill
created: 2026-04-15
status: active
---

# Plan: /audiogen — ElevenLabs Game-Audio Generation Skill

## Overview

Design and implement a Claude Code skill `/audiogen` that generates game audio
(background music, character voices, sound effects) via the ElevenLabs APIs,
modeled on the shape of `github.com/zeveck/imagegen`. The skill is a single
directory of three files — `SKILL.md`, `generate.cjs`, `reference.md` — with
zero npm dependencies, installable via three `curl`s. The generator CLI
(`generate.cjs`) is dual-shape: it backs the skill AND runs standalone from
the shell / CI without Claude in the loop.

Three modalities:

- **Music** → `POST /v1/music`
- **Voice (TTS)** → `POST /v1/text-to-speech/{voice_id}`, plus a `voices` browse/search subcommand over the paginated `GET /v2/voices`
- **SFX** → `POST /v1/sound-generation`

All outputs default to `mp3_44100_128` and land under
`assets/audio/{music,voice,sfx}/`. When a target file already exists and
`--force` is not set, the resolver auto-versions by appending `-v2`,
`-v3`, etc. (mirroring imagegen). Music looping is not supported
in-generator (ElevenLabs has no native music-loop flag; users loop in the
engine/HTML). SFX `--loop` is a native API passthrough.

ElevenLabs returns `application/octet-stream` on all three generator success
responses — the CLI branches on `response.ok`, not on content-type prefix.

The skill's test surface is wired into the project's zskills three-suite
pattern (unit / e2e / build) in Phase 6. The unsafe-project hook's
`{{UNIT_TEST_CMD}}` / `{{FULL_TEST_CMD}}` placeholders are replaced in
**Phase 1** so enforcement is consistent across all subsequent phase
commits.

Node.js floor: **≥ 20.14** (required for the built-in `process.loadEnvFile`).

## Progress Tracker

| Phase | Status | Commit | Notes |
|-------|--------|--------|-------|
| 1 — Scaffold & shared core | ✅ | `ed606e8` | 50/50 tests, verifier `3c7265a` |
| 2 — Music generator | ✅ | `9238387` | 77/77 tests (27 new), verifier `dab80d4` |
| 3 — Voice generator + voices list (v2 + pagination) | ✅ | `c25968e` | 142/142 tests (65 new), verifier `1769160` |
| 4 — SFX generator | ⬚ | | |
| 5 — SKILL.md + reference.md | ⬚ | | |
| 6 — Install flow, smoke tests, zskills test wiring | ⬚ | | |

---

## Phase 1 — Scaffold & shared core

### Goal

Stand up `.claude/skills/audiogen/{SKILL.md, generate.cjs}` with the shared
machinery — arg parser, env loader, HTTP helper with retry, history writer,
output-path resolver (including auto-versioning) — so subsequent phases add
one endpoint each. Also finalize `.gitignore` additions and activate the
unsafe-project hook's test-capture enforcement.

### Work Items

- [ ] Create directory `.claude/skills/audiogen/`.
- [ ] Create `.claude/skills/audiogen/SKILL.md` with minimal frontmatter
      (real prose lands in Phase 5). Frontmatter fields fixed in this phase
      so install paths don't shift later:
  - `name: audiogen`
  - `description: Generate game audio (music, voices, sound effects) via ElevenLabs.`
  - `disable-model-invocation: false`
  - `allowed-tools: Bash(node */generate.cjs *)`
  - `argument-hint: <music|voice|sfx|voices> <description> [--voice-id ID] [--length-ms MS] [--duration SEC] [--output PATH]`
- [ ] Create `.claude/skills/audiogen/generate.cjs` implementing:
  - **CLI grammar** (see below — authoritative surface).
  - **Env loading** — `loadEnv()` (mirrors imagegen's walker verbatim):
    - Candidate list: `[process.cwd()]` (single candidate, NO walk-up from
      cwd), then walk upward from `path.dirname(__filename)` to `/`
      appending each ancestor to the candidate list.
    - For each candidate `d`, check `fs.existsSync(path.join(d, '.env'))`;
      if true, `process.loadEnvFile(...)` in try/catch, and on success
      **`return` immediately** (stop walking). Deduplicate candidates
      (cwd may equal an ancestor of `__dirname`).
    - **Overwrite semantics (corrected from round 1):**
      Node's `--env-file` / `process.loadEnvFile` give **shell-exported
      values precedence over file values**. So `ELEVENLABS_API_KEY=X` in
      the shell overrides `ELEVENLABS_API_KEY=Y` in `.env`. Document
      this in the `loadEnv()` doc comment and in SKILL.md Prerequisites.
      Reference: Node docs state "If the same variable is defined in the
      environment and in the file, the value from the environment takes
      precedence." (https://nodejs.org/api/cli.html#--env-fileconfig)
    - Node floor: requires Node ≥ 20.14 (when `process.loadEnvFile` was
      added). At CLI entry, check
      `typeof process.loadEnvFile !== 'function'`; if so,
      `fail("Node.js ≥ 20.14 required (process.loadEnvFile unavailable on " + process.version + ")")`.
    - `process.loadEnvFile` throws `ENOENT` on missing files (verified
      empirically) and `ERR_INVALID_ARG_TYPE` on directories. The
      try/catch swallows both; the `fs.existsSync` check pre-filters
      the common missing-file case.
  - **`fail(msg, details?)` helper** — prints to stderr as
    `audiogen: <msg>` + optional details block; `process.exit(1)`.
  - **`assertApiKey()`** — reads `ELEVENLABS_API_KEY`; if absent, fails
    with: `"ELEVENLABS_API_KEY is not set. Create one at https://elevenlabs.io/app/settings/api-keys and export it, or add it to a .env file in the project root."`.
  - **`callElevenLabs({method, path, query, body, outputPath, responseType = 'binary'})`** —
    builds URL `https://api.elevenlabs.io{path}?{query}`; sends request
    with headers `{'xi-api-key': key, 'content-type': 'application/json'}`;
    120-second `AbortSignal.timeout(120_000)`; applies retry+backoff
    (see **Retry policy**).
    - **On `response.ok` + `responseType === 'binary'`** (generators):
      Stream `response.body` via
      `Readable.fromWeb(response.body).pipe(writeStream)` to
      `fs.createWriteStream(outputPath)`, await `finish`. Verify
      bytes-written > 0; if 0, delete the file and fail with
      `"empty audio response; refine prompt or retry."`.
      If response content-type is `application/json`, this is
      unexpected for a generator endpoint — consume body and fail with
      "unexpected JSON success body: <first 500 chars>" (defensive
      against future API changes).
    - **On `response.ok` + `responseType === 'json'`** (voices list):
      Consume `response.text()` → `JSON.parse` → return the parsed
      object as the function's return value. `outputPath` is ignored
      for JSON responses. If parse fails, fail with the first 500
      chars of body and the parse error.
    - **On non-ok** (both modes): read body as text, try `JSON.parse`,
      extract `.detail?.message || .detail || .message || raw body`;
      call `fail()` with parsed message, HTTP status, URL, and any
      `xi-request-id` header. 422 responses mentioning `output_format`
      get the free-tier hint appended.
    - **Binary-mode branching key is `response.ok` + parsed
      content-type.** JSON-mode branching key is `response.ok` only.
  - **`appendHistory(record, writeFn = fs.appendFileSync)`** — writes
    one JSON line to `${cwd}/.audiogen-history.jsonl`. Signature
    exposes `writeFn` for test injection. On write failure, emits a
    stderr warning and returns; never aborts generation. Record shape:
    `{ts, id, parent_id?, type, prompt, model_id, output_path,
      output_format, request_body, request_id?, history_warning?}`.
  - **`resolveOutputPath({type, prompt, outputOption, outputFormat, force})`:**
    1. Derive `<ext>` from `outputFormat`: `mp3_*` → `mp3`, `pcm_*`
       or `wav_*` → `wav`, `opus_*` → `opus`, `ulaw_*` / `alaw_*` → `raw`,
       anything else → `bin`.
    2. If `outputOption` is set and resolves to an existing directory
       (or ends with `/`): base = `<outputOption>/<slug>.<ext>`.
    3. If `outputOption` is set and not a directory: base = `outputOption`
       verbatim (extension honored from the user's name, not reserved).
    4. If unset: base = `assets/audio/<type>/<slug>.<ext>`.
    5. If `base` does not exist OR `force` is true → return `base`.
    6. Otherwise auto-version: try `<prefix>-v2.<ext>`, `<prefix>-v3.<ext>`,
       … up to `-v999.<ext>`; return the first non-existent path. If all 999
       are taken, fail with "too many versions — clean up
       assets/audio/<type>/ or pass --output explicitly."
       Note: the `-vN` suffix is a *collision-avoidance* mechanism, not a
       version manifest. Filenames are not a stable history reference —
       use `--history-parent <id>` against `.audiogen-history.jsonl` to
       track iterations.
    7. **Symlinks:** follow per `fs.existsSync` / `fs.statSync` defaults
       (no special handling).
  - **`slugify(prompt)`:** first 40 chars of prompt; `.toLowerCase()`;
    replace any run of characters NOT matching `[a-z0-9]` with `-`;
    strip leading/trailing `-`. If result is empty (common for
    non-Latin prompts), fall back to
    `audio-<YYYYMMDD-HHMMSS>` (local time zone per
    `.claude/zskills-config.json` `timezone` field, default
    `America/New_York`). Exposed as a helper for tests.
  - **`mkdirpParent(outputPath)`** — `fs.mkdirSync(path.dirname(outputPath), {recursive: true})`.
  - **Routing:** dispatch first positional `music|voice|sfx|voices`
    to `runMusic`/`runTTS`/`runSFX`/`runVoicesList`. In Phase 1, each
    `run*` throws `new Error("not yet implemented")`; `--help` and
    `--dry-run` paths do not require `run*` to be wired.
  - **`--help`** prints the authoritative flag surface (see CLI grammar
    below). Phases 2–4 implement flag **behavior**; they do not add or
    remove flags from `--help`.
  - **`--dry-run`** short-circuit: after parsing AND after resolving
    request body + URL + output path, print a human-readable block to
    stdout and exit 0. No network, no history write, no filesystem
    mutation (no `mkdir`, no output file).
- [ ] **Move hook placeholder replacement from Phase 6 into Phase 1**:
      In `.claude/hooks/block-unsafe-project.sh`, replace `{{UNIT_TEST_CMD}}`
      with `node --test tests/*.test.js` and `{{FULL_TEST_CMD}}` with
      `bash scripts/test-all.sh`. Leave `{{UI_FILE_PATTERNS}}` as-is
      (sentinel-guarded; no UI in this project). Rationale: the hook's
      placeholder-sentinel exit (lines 97-101) currently disables
      enforcement. Replacing early means all Phase-2+ commits are
      enforced consistently rather than suddenly activating during
      Phase 6.
      **Hook activation on Phase 1's own commit:** the hook reads the
      on-disk copy of `block-unsafe-project.sh` at pre-commit time, and
      by then the file is already placeholder-free (the edit is part
      of Phase 1's staged diff). Phase 1's commit therefore runs under
      active enforcement; the AC below includes running tests with
      output captured to `.test-results.txt` so the transcript check
      passes.
- [ ] **Update `.gitignore`** at repo root (`/workspaces/audiogen/.gitignore`)
      to append (create if missing):
      - `.audiogen-history.jsonl`
      - `.audiogen-voices.json`
      - `assets/audio/`
      Each on its own line; preserve existing entries.
- [ ] Create `tests/` directory at the repo root
      (`/workspaces/audiogen/tests/`).
- [ ] `tests/args.test.js` (`node:test`):
  - Positional `music|voice|sfx|voices` routes correctly.
  - `--output`, `--output-format`, `--seed`, `--model-id`, `--force`
    parse.
  - `--help` exits 0.
  - Missing required positional yields a clear error and non-zero exit.
- [ ] `tests/env.test.js`:
  - `loadEnv()` finds `.env` in cwd.
  - `loadEnv()` walks upward until filesystem root.
  - `loadEnv()` no-ops cleanly when no `.env` exists anywhere.
  - On Node < 20.14 (simulated by deleting `process.loadEnvFile`
    pre-test), CLI fails with the version error.
- [ ] `tests/paths.test.js`:
  - `slugify()` cases: basic ASCII, all-punctuation, empty-input
    fallback (`audio-<timestamp>` regex assertion),
    Japanese/emoji input produces timestamp fallback.
  - `resolveOutputPath` default dir per type.
  - `resolveOutputPath` honors `--output` directory.
  - `resolveOutputPath` honors `--output` file.
  - `resolveOutputPath` auto-bumps to `-v2`, `-v3` when file exists.
  - `resolveOutputPath` returns base when `force` is true even if
    file exists.
  - **Tmpdir assertion:** run `generate.cjs <type> ... --dry-run`
    with `cwd = mktempdir`, then assert tmpdir contains no `assets/`
    afterward — dry-runs must not create directories.
- [ ] `tests/history.test.js`:
  - `appendHistory` writes one valid JSON line.
  - Two calls produce two parseable lines.
  - `appendHistory` with injected `writeFn` that throws: emits
    warning, does not throw.

### Design & Constraints

**CLI grammar** (authoritative — Phase 1 fixes this; Phases 2–4 add
*behavior* behind these flags, never new flags):

```
node generate.cjs <subcommand> [prompt_or_query_words...] [options]

Subcommands:
  music  <prompt...>         Generate a music track.
  voice  <text...>           Generate TTS audio; requires --voice-id.
  sfx    <prompt...>         Generate a sound effect.
  voices [query...]          List/search voices; populates local cache.

Common options:
  --output PATH              Explicit output path or directory.
  --output-format FMT        Default mp3_44100_128.
  --seed N                   Integer seed (where supported).
  --model-id ID              Override the endpoint's default model.
  --dry-run                  Print resolved request + output path; no network.
  --force                    Overwrite existing output file (disables auto-version).
  --history-id ID            Group-tag for iteration threads.
  --history-parent ID        Parent record's id; marks this as a derivative.
  --help                     Show usage.

Music-only:
  --length-ms MS             3000-600000. Default 30000.
  --force-instrumental       No vocals.

Voice-only:
  --voice-id ID_OR_NAME      Required. Exact name in cache (case-insensitive),
                              or 20-char alphanumeric voice-id passthrough.
  --language-code CODE       e.g. en, ja.
  --stability N              0-1.
  --similarity-boost N       0-1.
  --style N                  0-1.
  --speed N                  0.5-2.

SFX-only:
  --duration N               0.5-30 seconds. Optional (API auto-derives).
  --loop                     Native API flag (v2 model only).
  --prompt-influence N       0-1. Default 0.3.

Voices-only:
  --language CODE            Filter by language.
  --gender male|female       Filter.
  --accent STR               Substring match on accent labels.
  --category STR             e.g. premade, cloned, professional.
  --json                     Emit raw JSON instead of table.
  --refresh                  Ignore cache, re-fetch.
  --page-size N              Override pagination page size (default 100, max 100).
```

**Arg parser ordering rules:**

1. First non-flag positional is the subcommand. Must be one of
   `music|voice|sfx|voices`. Anything else → fail with usage.
2. Subsequent non-flag positionals are joined by single space into
   `prompt` (for music/voice/sfx) or `query` (for voices).
3. Flags may appear anywhere after the subcommand. Unknown flags → fail.
4. Flags with values consume the next token (`--seed 42`). No `=` form.
5. Boolean flags take no value.

**Retry policy:**

- Applies inside `callElevenLabs`.
- Retry on HTTP 429, 500, 502, 503.
- Do NOT retry on 400, 401, 402, 403, 404, 413, 422.
- Max 3 attempts (1 initial + 2 retries).
- Backoff: 1000 ms × 2^(attempt-1), plus up to 500 ms jitter.
- On 429, honor `retry-after` header (seconds or HTTP-date) when
  present, clamped to a max of 30 s per wait.
- Each request has a 120-second abort timeout via
  `AbortSignal.timeout(120_000)`.

**Response handling** (corrected from round 1):

- Branching key: `response.ok` (HTTP 200-299). Content-Type is informational only.
- Generator endpoints (music, TTS, SFX) return
  `application/octet-stream` per ElevenLabs docs (verified
  2026-04-15). The skill streams bytes directly; any
  `application/json` success response is treated as a defensive
  error (unexpected future API change).
- Error responses carry JSON bodies with `detail.message` or
  `detail`; the fail() message surfaces this.

**Error-message format** (uniform across phases):

```
audiogen: <one-line summary>
  endpoint: <METHOD> <url>
  status:   <N> <reason>
  detail:   <parsed message or first 500 chars of body>
  request-id: <xi-request-id header value, if present>
  hint:     <optional, e.g. "Try --output-format mp3_44100_64 (free tier)">
```

For 422 responses that mention `output_format` in the detail, append
the hint `"Free-tier accounts are restricted to mp3_44100_64. Try --output-format mp3_44100_64."`.

**Zero npm deps.** Only built-in `node:fs`, `node:path`,
`node:stream/web`, `node:test`, `node:assert`, `node:url`, global
`fetch`, `process.loadEnvFile`.

**Test commands during Phases 1–5.** `scripts/test-all.sh` is not fully
wired until Phase 6, but Phase 1's hook-placeholder replacement makes
the hook *check for `bash scripts/test-all.sh`* in the transcript. The
unrewritten `scripts/test-all.sh` still runs end-to-end — it just uses
echo-TODO stubs in its CONFIGURE block that exit 0. So:
- For unit-test iteration during development use
  `node --test tests/*.test.js > .test-results.txt 2>&1`.
- **Before each phase commit** (Phase 1 onward), also run
  `bash scripts/test-all.sh > .test-results.txt 2>&1` once to satisfy
  the hook's transcript check. The TODO-stub suites return pass
  trivially until Phase 6 wires them; this is expected and
  harmless.

### Acceptance Criteria

- [ ] `node .claude/skills/audiogen/generate.cjs --help` exits 0 and
      prints usage covering all four subcommands and every flag from
      the CLI grammar block above.
- [ ] `node .claude/skills/audiogen/generate.cjs music "test" --dry-run`
      exits 0, prints URL
      `https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128`,
      prints request body `{"prompt":"test","music_length_ms":30000}`,
      and prints output path `assets/audio/music/test.mp3` — verified
      by stubbed `fetch` that throws if called (i.e., asserts no
      network).
- [ ] Equivalent dry-run assertions pass for `voice`, `sfx`, and
      `voices` subcommands.
- [ ] With `ELEVENLABS_API_KEY` unset and no dry-run flag, the CLI
      exits 1 with the exact message in `assertApiKey`.
- [ ] `tests/paths.test.js` asserts empty-slug fallback matches
      `/^audio-\d{8}-\d{6}$/`.
- [ ] `tests/paths.test.js` tmpdir test: dry-run does not create
      `assets/` in the tmpdir.
- [ ] `node --test tests/*.test.js > .test-results.txt 2>&1` passes
      with 0 failures.
- [ ] `bash scripts/test-all.sh > .test-results.txt 2>&1` runs
      end-to-end (all three suites return pass/skip — remember,
      before Phase 6 the shell-level CONFIGURE slots still contain
      echo-TODO stubs, so pass is trivially satisfied).
- [ ] `node -c .claude/skills/audiogen/generate.cjs` exits 0.
- [ ] `grep -c '{{UNIT_TEST_CMD}}' .claude/hooks/block-unsafe-project.sh`
      returns 0.
- [ ] `grep -c '{{FULL_TEST_CMD}}' .claude/hooks/block-unsafe-project.sh`
      returns 0.
- [ ] `.gitignore` contains all three new entries (verified by
      `grep -Fx '.audiogen-history.jsonl' .gitignore` etc.).

### Dependencies

None (first phase).

---

## Phase 2 — Music generator

### Goal

Wire `runMusic` against `POST /v1/music`, producing a valid mp3 file;
extend dry-run and history coverage.

### Work Items

- [ ] Implement `runMusic({prompt, opts})`:
  - Endpoint: `POST /v1/music?output_format={format}`.
  - Body: `{prompt, music_length_ms}`; include `force_instrumental: true`
    only if set; include `seed` only if set. Do not send
    `composition_plan` in this phase (looping is out of scope).
  - Validate `music_length_ms` in parser: `[3000, 600000]`. Out-of-range
    → fail pre-network.
  - `--loop` → fail before network with
    `"Music loops are not supported. Loop playback in your engine / HTML audio."`.
  - Validate `output-format` in parser against regex
    `/^(mp3_\d+_\d+|pcm_\d+|opus_\d+_\d+|ulaw_8000|alaw_8000)$/`.
    Wav formats → fail with
    `"Music endpoint does not support WAV output. Use mp3_* or pcm_*."`.
  - Default output path via `resolveOutputPath({type: 'music', ...})`
    → `assets/audio/music/<slug>.mp3` (with auto-versioning).
  - On success: append one history record (`type: "music"`,
    `model_id: opts.modelId ?? "music_v1 (server default)"`) and print
    the final output path to stdout.
- [ ] Add `tests/music.test.js` using a fetch stub:
  - Dry-run body assertion.
  - `--length-ms 2000` rejected in parser.
  - `--length-ms 600001` rejected.
  - `--loop` rejected with documented message.
  - `--output-format wav_44100` rejected with documented message.
  - Stubbed 200 + `application/octet-stream` + 1-KB body: file created,
    history appended, bytes match stub.
  - Stubbed 200 + 0-byte body: file deleted, fail with empty-response
    message.
  - Stubbed 400 + JSON body: fail() with parsed detail surfaced.
  - Stubbed 422 + detail containing `"output_format"`: fail message
    includes the free-tier hint.
  - Stubbed 429 + `retry-after: 1`: second call succeeds.
  - Auto-versioning: pre-existing `assets/audio/music/x.mp3` →
    stubbed run of `music "x"` writes `assets/audio/music/x-v2.mp3`.

### Design & Constraints

- `prompt` must be non-empty after trimming; empty → fail in parser.
- Slug from `prompt`, truncated to 40 chars (via `slugify`).

### Acceptance Criteria

- [ ] `node generate.cjs music "chiptune boss battle" --length-ms 15000 --seed 7 --dry-run`
      prints URL + body + output path matching the spec.
- [ ] `--length-ms 2000` exits 1 before network with
      "music_length_ms must be in [3000, 600000]".
- [ ] `--loop` fails before network with the documented message.
- [ ] **Manual acceptance** (not run in CI) — with a real API key,
      `node generate.cjs music "title screen" --length-ms 5000` writes
      a valid mp3 (ffprobe readable) and a history line with correct
      fields.
- [ ] `node --test tests/music.test.js > .test-results.txt 2>&1` passes.

### Dependencies

Phase 1.

---

## Phase 3 — Voice generator + voices list (v2 + pagination)

### Goal

Two subcommands:
- `voice <text...> --voice-id X` → TTS audio.
- `voices [query...]` → cached voice catalog browse/search over the
  paginated `GET /v2/voices`.

### Work Items

- [ ] Implement `runTTS({text, opts})`:
  - Endpoint: `POST /v1/text-to-speech/{voice_id}?output_format={format}`.
  - Body: `{text, model_id: opts.modelId ?? "eleven_multilingual_v2"}`,
    plus `language_code` if set, `seed` if set, and
    `voice_settings: {...}` containing only user-specified fields.
  - Validate `text.length <= 40000` in parser.
  - Default output: `resolveOutputPath({type: 'voice', ...})` →
    `assets/audio/voice/<slug>.mp3`.
- [ ] Implement `resolveVoiceId(rawInput, cachePath)` — **cache-first
      resolution, then ID passthrough**:
  0. `input = rawInput?.trim()` — strip whitespace (common from
     copy-paste).
  1. If `input` is undefined/empty → fail with
     `"Voice generation requires --voice-id. Browse: node generate.cjs voices [query]"`.
  2. Read cache file if it exists. If cache is missing AND input is
     NOT a plausible voice-id (fails regex `/^[A-Za-z0-9]{20}$/`) →
     fail with `"No voice cache. Run: node generate.cjs voices"`.
  3. If cache is readable, find voices where
     `voice.name.toLowerCase() === input.toLowerCase()`.
     - Exactly 1 match → return its `voice_id`. **If `input` also
       matches `/^[A-Za-z0-9]{20}$/`**, emit a stderr warning:
       `"audiogen: '<input>' matches both a voice-id pattern and a cached voice name; resolving as the cached name's voice_id. If you intended the raw ID, rename the conflicting voice or pass a different voice."`
     - Multiple matches → fail with a disambiguation block listing
       each `voice_id`, `category`, and relevant labels, ending with
       `"Pass the ID directly: --voice-id <id>"`.
     - Zero matches: continue to step 4.
  4. If input matches `/^[A-Za-z0-9]{20}$/`, return `input`
     verbatim (ID passthrough). Otherwise fail with
     `"No voice named '<input>' in cache and input is not a 20-char voice-id. Try --refresh."`.
- [ ] Implement `runVoicesList({query, opts})` against **`GET /v2/voices`**:
  - Cache file: `.audiogen-voices.json` in cwd.
  - Cache schema: `{fetched_at: <iso8601>, voices: [...]}`.
  - Cache TTL: 24 h; `--refresh` bypasses TTL.
  - Cache write is atomic: write to `.audiogen-voices.json.tmp` then
    `fs.renameSync`. On read, if `JSON.parse` throws, treat as cache
    miss and refetch (log "cache parse error; refetching" to stderr).
  - On cache miss: call
    `GET /v2/voices?page_size=100&include_total_count=false` (via
    `callElevenLabs({..., responseType: 'json'})`) then follow
    `next_page_token` until `has_more` is false. Accumulate into
    `voices`. `--page-size N` (1-100) can override; default 100.
    **`include_total_count=false` is important** — the endpoint's
    docs warn that `include_total_count=true` (the default) incurs a
    per-page performance cost; we use `has_more` for pagination, not
    the total count.
  - Client-side filtering:
    - `query` present: case-insensitive substring match against
      `voice.name` and any string value in `voice.labels`.
    - `--language`: substring match against
      `voice.labels?.language` or within `voice.fine_tuning?.language` /
      `voice.verified_languages[].language` (any of them).
    - `--gender`: exact-lower match against `voice.labels?.gender`.
    - `--accent`: substring match against `voice.labels?.accent`.
    - `--category`: exact match against `voice.category`.
    - Rows missing expected fields (e.g., no `labels`) are tolerated
      — treat as no-match for those filters but include on
      unfiltered queries.
  - Output format:
    - Default: ASCII table with columns
      `NAME | ID | CATEGORY | LANG | GENDER | ACCENT | PREVIEW`.
      Fixed-width; piped-friendly (no ANSI). Row cap 50, sorted
      alphabetically by name. If filter produces > 50,
      trailing `(+N more — refine query or use --json)`.
    - `--json`: raw filtered array to stdout, no pagination/row-cap.
  - `--dry-run` on `voices`: do not fetch and do not touch cache.
    Print the resolved URL + page_size + filter state; exit 0.
- [ ] Tests (`tests/voice.test.js`, `tests/voices.test.js`) with
      fetch stub AND fixture cache file:
  - Voice: 20-char ID accepted when cache has no such name.
  - Voice: name match in fixture cache resolves correctly.
  - Voice: duplicate names in cache → disambiguation error listing all IDs.
  - Voice: missing cache + 20-char ID → passthrough OK.
  - Voice: missing cache + non-ID input → clear error pointing at
    `voices`.
  - Voice: text over 40k chars rejected in parser.
  - Voice: dry-run body + URL shape.
  - Voices: cache hit (fresh), no network.
  - Voices: stale cache triggers refetch.
  - Voices: `--refresh` bypasses fresh cache.
  - Voices: **pagination loop** — stub returns page 1 with
    `has_more: true, next_page_token: "abc"`, page 2 with
    `has_more: false`; cache contains concatenation of both pages.
  - Voices: cache parse error → refetch + warning.
  - Voices: atomic write — assert `.audiogen-voices.json.tmp` never
    left behind after a successful write (check `existsSync` returns
    false post-run).
  - Voices: filter combinators (query + gender + accent).
  - Voices: `--json` emits parseable JSON matching the filter.

### Design & Constraints

- All filtering is client-side; the `v2/voices` server-side
  `search=` is not used — we filter against cached fields to keep
  queries fast and offline-capable.
- Cache file is per-cwd so worktrees don't clobber the main repo's
  cache.
- Missing optional fields (e.g., `labels`) are tolerated.

### Acceptance Criteria

- [ ] `node generate.cjs voice "Halt!" --voice-id JBFqnCBsd6RMkjVDRZzb --dry-run`
      prints URL
      `https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=mp3_44100_128`
      and body `{"text":"Halt!","model_id":"eleven_multilingual_v2"}`.
- [ ] With a fixture cache containing a voice named "Rachel" with id
      `21m00Tcm4TlvDq8ikWAM`, `--voice-id Rachel` resolves to that ID.
- [ ] With a fixture cache containing TWO voices both named "Adam",
      `--voice-id Adam` fails with the disambiguation block.
- [ ] `node generate.cjs voices --dry-run` never fetches and never
      touches the cache file on disk (verified with a stubbed `fetch`
      that throws and a pre-run file-mtime check).
- [ ] Pagination test (described above) passes.
- [ ] `node --test tests/voice.test.js tests/voices.test.js > .test-results.txt 2>&1`
      passes.

### Dependencies

Phase 1.

---

## Phase 4 — SFX generator

### Goal

Wire `runSFX` against `POST /v1/sound-generation`.

### Work Items

- [ ] Implement `runSFX({text, opts})`:
  - Endpoint: `POST /v1/sound-generation?output_format={format}`.
  - Body: `{text, model_id: opts.modelId ?? "eleven_text_to_sound_v2",
    prompt_influence: opts.promptInfluence ?? 0.3}`; include
    `duration_seconds` only if set; include `loop: true` only if set.
  - Parser validation: `--duration` in `[0.5, 30]`;
    `--prompt-influence` in `[0, 1]`.
  - `--loop` with `--model-id` ≠ `eleven_text_to_sound_v2` → fail with
    `"--loop is only supported by eleven_text_to_sound_v2."`.
  - Reject `wav_*` output format (same message as music).
  - Default output: `resolveOutputPath({type: 'sfx', ...})` →
    `assets/audio/sfx/<slug>.mp3`.
- [ ] `tests/sfx.test.js`:
  - Dry-run body with defaults (no duration, no loop,
    prompt_influence 0.3).
  - Dry-run with `--duration 2 --loop --prompt-influence 0.6`.
  - `--duration 0.4` and `--duration 31` both rejected in parser.
  - `--loop --model-id eleven_text_to_sound_v1` rejected.
  - `--output-format wav_44100` rejected.
  - Stubbed 200 + `application/octet-stream` writes file;
    0-byte body removes file and fails.

### Design & Constraints

- `duration_seconds` serialized as a number, not a string.

### Acceptance Criteria

- [ ] `node generate.cjs sfx "door slam, reverb" --duration 2.0 --dry-run`
      prints body
      `{"text":"door slam, reverb","model_id":"eleven_text_to_sound_v2","prompt_influence":0.3,"duration_seconds":2}`.
- [ ] `--duration 31` exits 1 before network.
- [ ] `node --test tests/sfx.test.js > .test-results.txt 2>&1` passes.

### Dependencies

Phase 1.

---

## Phase 5 — SKILL.md + reference.md

### Goal

Replace the SKILL.md skeleton with real documentation; author
`reference.md` with prompt/style/voice presets.

### Work Items

- [ ] Write `.claude/skills/audiogen/SKILL.md` (≤ 500 lines — soft
      guideline; see rationale under "Design & Constraints"):
  1. Frontmatter (copied forward from Phase 1; do not add or remove
     fields).
  2. `# /audiogen — Game Audio Generation via ElevenLabs` + 1–2
     sentence pitch.
  3. **Prerequisites** — Node ≥ 20.14,
     `ELEVENLABS_API_KEY` env var (or `.env`), ElevenLabs account tier
     notes.
  4. **Quick Start** — one example per modality.
  5. **Handling No Arguments** — ask the user what to generate.
  6. **Subcommand Reference** — one compact subsection per subcommand
     (flag behavior mirrors Phase 1's `--help` — do NOT introduce new
     flags).
  7. **How to Compose Prompts** — general guidance + pointer to
     `reference.md`.
  8. **Choosing a Voice** — how to use the `voices` subcommand; cache
     lifetime; archetypes reference.
  9. **Output Organization** — default layout; override via `--output`;
     auto-versioning behavior (`-v2`, `-v3`, up to `-v999`; `--force`
     to overwrite). Explicit disclaimer: filenames are a
     collision-avoidance mechanism, not a version manifest. Track
     iterations via `--history-parent <id>` against
     `.audiogen-history.jsonl`.
  10. **Confirmation Policy** — warn on batch jobs (3+); estimated-cost
      callout; otherwise generate without asking.
  11. **Handling Errors** — `fail()` message shape; common 4xx causes;
      role of `request-id`.
  12. **Regeneration & Iteration** — history file, `--history-id`,
      `--history-parent`.
  13. **Loop Caveat** — music has no native loop (engine-side / HTML);
      SFX has native `--loop` on the v2 model.
  14. **Cost** — a single paragraph saying "check
      <https://elevenlabs.io/pricing/api> at install time; approximate
      rates at time of writing are …" with the numbers from the
      research doc but explicitly marked as non-authoritative. **The
      live pricing page wins in any conflict.**
  15. **Licensing** — paid-tier output → perpetual commercial rights.
      Voice cloning requires consent; no public-figure cloning.
  16. **Script Location** — `.claude/skills/audiogen/generate.cjs`;
      dual usage as standalone CLI.
- [ ] Write `.claude/skills/audiogen/reference.md`:
  - **Music presets** (≥ 10 entries).
  - **Voice archetypes** (≥ 6 entries): each with starting
    `voice_settings` + a suggested `voices` search query. No voice IDs
    listed (IDs change; cache is the source of truth).
  - **SFX categories** (≥ 5): each with 3–5 example prompts.
- [ ] Create `tests/build/` directory (not matched by the unit glob
      `tests/*.test.js`). Write `tests/build/skill-structure.test.js`:
  - Read SKILL.md, extract YAML frontmatter block (between the two
    `---` delimiters), regex-assert presence of `name`,
    `description`, `disable-model-invocation`, `allowed-tools`,
    `argument-hint`.
  - Assert SKILL.md line count ≤ 500 (soft cap — fail message should
    say "exceeds 500-line soft cap; consider splitting into
    reference.md").
  - Assert reference.md has ≥ 10 music presets, ≥ 6 voice archetypes,
    ≥ 5 SFX categories (detect via section-header regex).
  - Assert no `{{PLACEHOLDER}}` strings remain in SKILL.md or reference.md.

### Design & Constraints

- SKILL.md must be readable standalone.
- Presets are passthrough templates — the skill does not auto-inject.
- Voice archetypes are *search guidance*, not id lists.
- **500-line soft cap rationale:** Claude Code loads SKILL.md
  aggressively per skill invocation; long files burn context without
  proportionate UX value. 500 is generous vs imagegen's ~250 but still
  a soft ceiling. If future prose legitimately exceeds it, raise the
  cap in `tests/build/skill-structure.test.js` with a commit message
  explaining why — never delete content just to satisfy the test.

### Acceptance Criteria

- [ ] SKILL.md has all 16 sections; line count ≤ 500;
      frontmatter still matches Phase 1's locked fields.
- [ ] reference.md has ≥ 10 music presets, ≥ 6 voice archetypes, ≥ 5
      SFX categories with ≥ 3 examples each.
- [ ] Cost section cites the live pricing URL and labels its numbers
      as non-authoritative.
- [ ] `node --test tests/build/skill-structure.test.js > .test-results.txt 2>&1` passes.

### Dependencies

Phases 2–4 (docs mirror the real subcommand surface).

---

## Phase 6 — Install flow, smoke tests, zskills test wiring

### Goal

Installable skill + full zskills three-suite test integration.

### Work Items

- [ ] Write `README.md` at repo root (`/workspaces/audiogen/README.md`):
  - Two-sentence description of `/audiogen`.
  - Install options:
    1. **Agent-assisted**: "Ask your agent to install the skill from
       `github.com/<owner>/audiogen`" (templated — see below).
    2. **Manual curl** (post-publish): three `curl -O` commands. Use a
       top-of-file `REPO_URL` template variable so the three URLs
       update in one place.
    3. **Local copy** (immediate, pre-publish):
       `cp -r <this repo>/.claude/skills/audiogen <target>/.claude/skills/`.
  - Usage examples for all three subcommands.
  - `ELEVENLABS_API_KEY` setup (export or `.env`).
  - Dev setup: `node --test tests/`; `bash scripts/test-all.sh`.
- [ ] Create `tests/e2e/audiogen-e2e.js`:
  - If `ELEVENLABS_API_KEY` is unset OR `SKIP_E2E=1`, print
    `[skipped] set ELEVENLABS_API_KEY to run end-to-end tests` and
    `process.exit(0)`.
  - Otherwise: generate a 3-second music track, a short voice line
    (using voice id `JBFqnCBsd6RMkjVDRZzb`), and a 1-second SFX.
    Assert each file:
    - exists,
    - is non-empty,
    - passes the MP3-ish header test: first 3 bytes equal `ID3`
      (ASCII) OR `byte[0] === 0xFF && (byte[1] & 0xE0) === 0xE0`
      (valid MPEG frame-sync, 11 bits set).
  - Use `fs.mkdtempSync(os.tmpdir() + '/audiogen-e2e-')`; clean up on
    exit (both success and fail paths).
- [ ] **Rewrite** `scripts/test-all.sh`:
  - Replace the CONFIGURE block (lines 14-18) with:
    ```
    UNIT_TEST_CMD='node --test tests/*.test.js'
    E2E_TEST_CMD='node tests/e2e/audiogen-e2e.js'
    BUILD_TEST_CMD='node -c .claude/skills/audiogen/generate.cjs && node --test tests/build/*.test.js'
    ```
    (The unit glob is `tests/*.test.js` — only top-level `.test.js`
    files. `tests/build/` and `tests/e2e/` are excluded from unit by
    design, so `skill-structure.test.js` runs in build only and
    `audiogen-e2e.js` runs in e2e only.)
  - **Delete the port-gate E2E block** (lines 94-118) and replace with
    the standard `$?` pattern:
    ```
    header "E2E Tests ($E2E_TEST_CMD)"
    E2E_OUT=$(eval "$E2E_TEST_CMD" 2>&1)
    EXIT=$?
    echo "$E2E_OUT"
    if [ "$EXIT" -eq 0 ]; then
      if echo "$E2E_OUT" | grep -q "^\[skipped\]"; then
        record "E2E" "skip"
      else
        record "E2E" "pass"
      fi
    else
      record "E2E" "fail"
    fi
    ```
  - **Delete dead helpers** now that the port gate is gone:
    - `has_changed_source_files()` (lines 70-83)
    - `get_port()` (lines 41-57)
    - `check_port()` (lines 59-63)
  - Update `has_build_prerequisite()` (line 65-67) to
    `command -v node >/dev/null`.
  - Update the header comment (lines 6-8) to remove
    "Replace the {{PLACEHOLDER}} values" language.
- [ ] Update `.claude/zskills-config.json` `testing` block:
  - `"unit_cmd": "node --test tests/*.test.js"`
  - `"full_cmd": "bash scripts/test-all.sh"` (unchanged)
  - `"output_file": ".test-results.txt"` (unchanged)
  - `"file_patterns": ["tests/**/*.test.js", "tests/**/*.js"]`
- [ ] Update `/workspaces/audiogen/CLAUDE.md`, replacing every real
      TODO/placeholder marker (anchored-at-start-of-line
      occurrences — the backticked example on the line documenting
      the `NEVER modify working tree` rule is deliberately left
      alone):
  - Line ~5 (`_TODO: describe project layout...`): replace with
    `The /audiogen skill lives at \`.claude/skills/audiogen/\` as three files — SKILL.md (prompt/prose), generate.cjs (zero-dep Node CLI, dual-shape as skill backend + standalone tool), reference.md (preset library). Tests in \`tests/\`; helper scripts in \`scripts/\`; hooks in \`.claude/hooks/\`.`
  - Line ~10 (`# TODO: set dev server command ...`): replace with
    `No dev server — /audiogen is a CLI-only skill.`
  - Line ~19 (`// TODO: set auth-bypass ...` inside auth_bypass block):
    replace the whole JS stub with a comment
    `// No auth gate — N/A for this project.`
  - Line ~26 (`# TODO: UNIT_TEST_CMD`): replace with
    `node --test tests/*.test.js`.
  - Line ~58 (`_TODO: describe test-file locations ...`): replace with
    `Unit tests: \`tests/*.test.js\`. Build-suite tests: \`tests/build/*.test.js\`. End-to-end tests: \`tests/e2e/\` (require \`ELEVENLABS_API_KEY\`; graceful skip otherwise).`
  - **Do not** modify the backticked illustrative example in the
    "NEVER modify the working tree" rule. That `# TODO: UNIT_TEST_CMD`
    substring is documentation, not a placeholder.
- [ ] Run the full suite and capture:
      `bash scripts/test-all.sh > .test-results.txt 2>&1`.

### Design & Constraints

- Unit suite completes in under 5 s on a cold node process.
- E2E must not run in CI without a key; `ELEVENLABS_API_KEY` absence
  → graceful skip.
- **Build check** does two distinct things: (a) `node -c` syntax
  scan on `generate.cjs`, (b) run `tests/skillmd.test.js` which
  validates SKILL.md frontmatter + structural invariants. This gives
  the build suite a distinct failure mode vs unit (unit tests
  behavior; build tests shape).
- README's install section uses a templated `REPO_URL` placeholder —
  do NOT hard-code a non-existent URL.

### Acceptance Criteria

- [ ] `bash scripts/test-all.sh > .test-results.txt 2>&1` completes
      with unit=pass, e2e=skip (no key) or pass (key), build=pass.
- [ ] `scripts/test-all.sh` contains no `{{` placeholder substrings
      (`grep -c '{{' scripts/test-all.sh` returns 0).
- [ ] `scripts/test-all.sh` contains no `check_port`, `get_port`, or
      `has_changed_source_files` references (`grep -cE 'check_port|get_port|has_changed_source_files' scripts/test-all.sh` returns 0).
- [ ] `/workspaces/audiogen/CLAUDE.md` has no line-anchored TODO
      markers (`grep -cE '^(# TODO:|// TODO:|_TODO:)' CLAUDE.md`
      returns 0). The backticked `# TODO: UNIT_TEST_CMD` substring
      inside the "NEVER modify working tree" rule is NOT a TODO
      placeholder and is intentionally preserved.
- [ ] `.claude/zskills-config.json` `testing.unit_cmd` and
      `testing.file_patterns` are non-empty.
- [ ] README has a `REPO_URL` template variable referenced by the
      curl commands (verified by grep).
- [ ] A machine without `ELEVENLABS_API_KEY` runs
      `bash scripts/test-all.sh` to green (E2E skipped).

### Dependencies

Phases 1–5.

---

## Plan Quality

**Drafting process:** `/draft-plan` with 2 rounds of adversarial review
(reviewer + devil's advocate in parallel each round).

**Convergence:** Converged at round 2 on targeted edits. Round 3 was
not run — round-2 fixes were small, localized changes to
previously-adversarially-reviewed architecture (env walker copied
verbatim from imagegen, `responseType` parameter addition to an
existing helper, pagination query-string flag, test-suite directory
split, shell command simplification, documentation corrections).
Running a third round for verification-of-edits would have been
belt-and-suspenders with diminishing marginal value.

**Remaining concerns:**

- **Judgment call (not fixed):** cache-first voice-id resolution
  keeps its precedence over raw-ID passthrough when a 20-char name
  collides with ID shape. A stderr warning fires in that edge case;
  reversing the precedence would introduce an inverse bug (user
  pastes valid ID that happens to look name-like → misresolved).
  Acceptable risk.
- **External-liveness dependency:** Phase 5 cost table is an
  approximation; the live
  <https://elevenlabs.io/pricing/api> wins in any conflict. Prose
  explicitly labels the numbers as non-authoritative.
- **Voice catalog schema drift:** the plan tolerates missing
  optional fields (`labels`, `category`) in `v2/voices` responses;
  new required fields added by ElevenLabs would still require a code
  update.

### Round history

| Round | Reviewer findings | Devil's advocate findings | Disposition |
|-------|-------------------|---------------------------|-------------|
| 1 | 16 (1 blocking, 3 major, 9 minor, 3 OK) | 12 (1 blocking, 7 major, 4 minor) | 25 fixed, 3 OK (no action), see `/tmp/draft-plan-review-round-1.md` |
| 2 | 7 (2 blocking, 5 major) | 10 (2 blocking, 4 major, 4 minor) | 16 fixed, 1 judgment (voice-id precedence), see `/tmp/draft-plan-review-round-2.md` |

### Load-bearing empirical verifications performed during review

- **Node `process.loadEnvFile` availability:** added in Node v20.14.0;
  verified against https://nodejs.org/docs/latest-v20.x/api/process.html
  and empirically via `node -e 'typeof process.loadEnvFile'`.
- **Node `process.loadEnvFile` overwrite direction:** shell wins over
  file; verified against https://nodejs.org/api/cli.html#--env-fileconfig
  and empirically with `FOO=shell node -e ...`.
- **ElevenLabs music endpoint response type:**
  `application/octet-stream`; verified against
  https://elevenlabs.io/docs/api-reference/music/compose.
- **ElevenLabs voices endpoint:** `/v2/voices` with pagination
  (`has_more`, `next_page_token`, `page_size` default 10 max 100,
  `include_total_count` defaults to `true` and incurs perf cost);
  verified against
  https://elevenlabs.io/docs/api-reference/voices/search.
- **Imagegen env walker shape:** cwd as single candidate, then
  walk-up from `__dirname` with `return` on first success; verified
  against the imagegen `generate.cjs` source.
- **`scripts/test-all.sh` port gate** (lines 94-118 of installed
  zskills test harness): present, with
  `has_changed_source_files()` helper that fails when `tests/e2e/`
  is edited without a dev server. Confirmed by reading the file.
- **`.claude/hooks/block-unsafe-project.sh` placeholder sentinel**
  (lines 97-101): confirmed present and gates test-capture
  enforcement behind `{{UNIT_TEST_CMD}}` / `{{FULL_TEST_CMD}}`
  replacement.
