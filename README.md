# audiogen

Generate game audio — music, voices, and sound effects — from a single
[Claude Code](https://github.com/anthropics/claude-code) skill. Backed
by the [ElevenLabs](https://elevenlabs.io) API. Three files, zero npm
deps, usable either as a `/audiogen` slash command inside an agent or as
a standalone Node CLI from your terminal or CI job.

---

## Hear it

Three clips generated live by the skill — full command and prompt shown
so you can reproduce them.

### 🎵 Music — chiptune boss battle (12 s, 193 KB)

<audio controls src="examples/music-chiptune-boss-battle.mp3"></audio>

▶️ [`examples/music-chiptune-boss-battle.mp3`](examples/music-chiptune-boss-battle.mp3)

```
/audiogen music aggressive 8-bit NES chiptune boss battle, fast driving 150 BPM, pulse-wave lead, triangle bass, noise snare, heroic minor key --length-ms 12000 --force-instrumental
```

### 🎙 Voice — Alice TTS (2 s, 26 KB)

<audio controls src="examples/voice-alice-greeting.mp3"></audio>

▶️ [`examples/voice-alice-greeting.mp3`](examples/voice-alice-greeting.mp3)

```
/audiogen voice "Have you any gold, traveller?" --voice-id Alice
```

`--voice-id Alice` resolves by name against the local voice cache — no
need to hardcode the 20-char voice ID.

### 🔊 SFX — coin pickup (1 s, 17 KB)

<audio controls src="examples/sfx-coin-pickup.mp3"></audio>

▶️ [`examples/sfx-coin-pickup.mp3`](examples/sfx-coin-pickup.mp3)

```
/audiogen make a coin pickup chime about a second long
```

The agent routed that natural-language request to the `sfx` subcommand,
expanded the prompt (`"bright metallic coin pickup chime, short
satisfying upward pitch sweep"`), and chose `--duration 1`. That
interpretation step is the whole point of the slash-command interface —
you describe, the skill figures out the call.

---

## Install

You can probably just **ask your agent**: "install the audiogen skill
from `github.com/zeveck/audiogen` into this project." It will follow
the manual steps below.

To do it yourself, three files into `.claude/skills/audiogen/`:

```bash
mkdir -p .claude/skills/audiogen
cd .claude/skills/audiogen
curl -O https://raw.githubusercontent.com/zeveck/audiogen/main/.claude/skills/audiogen/SKILL.md
curl -O https://raw.githubusercontent.com/zeveck/audiogen/main/.claude/skills/audiogen/generate.cjs
curl -O https://raw.githubusercontent.com/zeveck/audiogen/main/.claude/skills/audiogen/reference.md
```

Confirm:

```bash
node .claude/skills/audiogen/generate.cjs --help
```

---

## Configure

```bash
# Option A — export in your shell
export ELEVENLABS_API_KEY='sk_...'

# Option B — .env at project root (auto-loaded)
echo 'ELEVENLABS_API_KEY=sk_...' > .env
```

Get a key at <https://elevenlabs.io/app/settings/api-keys>. Free tier
(10K credits/month) works for everything the skill does; paid tiers
remove the attribution requirement on output. Node **≥ 20.14** required
(for the built-in `process.loadEnvFile`).

---

## Use

### From Claude Code

The slash command accepts natural language *or* explicit
subcommands. The agent routes based on your phrasing.

```
/audiogen generate a 30-second sorrowful string quartet for a funeral scene
/audiogen have the guard captain say "halt, traveller" gruffly
/audiogen short magical chime, like picking up a mana potion
/audiogen find me a british female voice
```

When you know what you want, drive it directly:

```
/audiogen music chiptune boss battle --length-ms 20000 --force-instrumental
/audiogen voice "Welcome, hero." --voice-id George --style 0.4
/audiogen sfx heavy iron portcullis slam --duration 2
/audiogen voices --accent british --gender female
```

### From the shell

`generate.cjs` is a self-contained Node CLI. Same flags, same
behavior, no agent required:

```bash
node .claude/skills/audiogen/generate.cjs music \
  "ambient forest loop, flute, gentle strings, 80 BPM" \
  --length-ms 30000 --force-instrumental

node .claude/skills/audiogen/generate.cjs voice \
  "Welcome, traveler." --voice-id George --speed 1.05

node .claude/skills/audiogen/generate.cjs sfx \
  "heavy iron portcullis slam, long reverb" --duration 2

node .claude/skills/audiogen/generate.cjs voices --limit 20
```

Outputs land under `assets/audio/{music,voice,sfx}/<slug>.mp3` by
default. Use `--output <path>` to redirect.

---

## What it does

| Subcommand | Endpoint | Output |
|---|---|---|
| `music` | `POST /v1/music` | 3 s–5 min tracks; genre/tempo/mood from prompt |
| `voice` | `POST /v1/text-to-speech/{voice_id}` | TTS, 40K-char input cap, `eleven_multilingual_v2` default |
| `sfx` | `POST /v1/sound-generation` | 0.5–30 s effects; `--loop` for seamless game ambience |
| `voices` | `GET /v2/voices` | Browse/filter catalog; cached 24 h to `.audiogen-voices.json` |

Plus:

- **Auto-versioning.** Re-running the same prompt writes `-v2`, `-v3`,
  etc. — no overwrites unless you pass `--force`.
- **History threading.** Every call appends a record to
  `.audiogen-history.jsonl` with an id; pass `--history-parent <id>`
  to mark follow-ups as derivatives. Lets you iterate across
  sessions.
- **Prompt presets.** ~20 music presets, ~15 voice archetypes, ~25 SFX
  entries in
  [`reference.md`](.claude/skills/audiogen/reference.md) — the agent
  expands these into full prompts when you name a style.
- **Retry & backoff.** 429/500/502/503 retried 3× with
  `Retry-After` honored.
- **Zero dependencies.** Uses Node 20.14+'s built-in `fetch` and
  `process.loadEnvFile`. No `npm install` anywhere.

See [`SKILL.md`](.claude/skills/audiogen/SKILL.md) for the full prompt
reference and edge-case catalogue.

---

## CI / GitHub Actions

```yaml
# .github/workflows/audio.yml
name: Generate level audio
on: workflow_dispatch
jobs:
  audio:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: |
          node .claude/skills/audiogen/generate.cjs music "battle theme" \
            --length-ms 45000 --output assets/audio/battle.mp3
        env:
          ELEVENLABS_API_KEY: ${{ secrets.ELEVENLABS_API_KEY }}
      - uses: actions/upload-artifact@v4
        with: { name: audio, path: assets/audio/ }
```

---

## Licensing & terms

- **Your generated audio**: paid tiers grant perpetual commercial
  rights (survive cancellation). Free tier requires attribution
  ("Sound effect/voice/music by ElevenLabs"). Verify your plan at
  <https://elevenlabs.io/pricing>.
- **Voice cloning (IVC/PVC)** is **out of scope** for this skill.
  ElevenLabs requires explicit, recorded consent from the voice owner
  and never permits public-figure cloning. Do that work through the
  ElevenLabs UI, not here.

---

## Development

```bash
node --test tests/*.test.js      # unit tests — fast, 184 cases
bash scripts/test-all.sh         # unit + e2e + build (e2e auto-skips without API key)
```

E2E tests actually hit the ElevenLabs API when `ELEVENLABS_API_KEY`
is set, burning ~400 credits per run. Safe to run in CI without
secrets; it no-ops.

---

## Credits

Shape and spirit borrowed from
[github.com/zeveck/imagegen](https://github.com/zeveck/imagegen) — the
zero-dep, single-directory, three-file skill pattern fits generative
media perfectly. audiogen's `generate.cjs` mirrors imagegen's env
walker and retry discipline verbatim.
