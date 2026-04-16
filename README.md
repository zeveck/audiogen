# audiogen

A Claude Code skill that generates game audio — music, voices, and sound
effects — via the ElevenLabs API. Three files, zero npm dependencies,
usable as a `/audiogen` slash-skill from inside an agent or as a
standalone CLI from your terminal or CI job.

## Install

`audiogen` ships as a self-contained skill directory: three files drop
into `.claude/skills/audiogen/` in any project and `/audiogen` is
immediately available.

Set a `REPO_URL` variable at the top of your shell to avoid repeating
the upstream path:

```bash
REPO_URL='<owner>/audiogen'   # e.g. acme/audiogen
```

### Option 1 — Agent-assisted (recommended)

Ask your Claude Code agent: "Install the audiogen skill from
`github.com/<owner>/audiogen` into this project." The agent will fetch
the three files and wire them up.

### Option 2 — Manual curl

```bash
mkdir -p .claude/skills/audiogen
curl -fsSL "https://raw.githubusercontent.com/${REPO_URL}/main/.claude/skills/audiogen/SKILL.md"     -o .claude/skills/audiogen/SKILL.md
curl -fsSL "https://raw.githubusercontent.com/${REPO_URL}/main/.claude/skills/audiogen/generate.cjs" -o .claude/skills/audiogen/generate.cjs
curl -fsSL "https://raw.githubusercontent.com/${REPO_URL}/main/.claude/skills/audiogen/reference.md" -o .claude/skills/audiogen/reference.md
```

### Option 3 — Local copy (pre-publish)

```bash
cp -r <path-to-audiogen>/.claude/skills/audiogen <your-project>/.claude/skills/
```

## Configure

Set `ELEVENLABS_API_KEY` either as an exported shell variable or in a
project-local `.env` at the repo root:

```bash
# option A — export
export ELEVENLABS_API_KEY='sk_...'

# option B — .env (auto-loaded by generate.cjs)
echo 'ELEVENLABS_API_KEY=sk_...' > .env
```

Requires **Node ≥ 20.14** (for `process.loadEnvFile`).

## Usage

Inside a Claude Code session:

```
/audiogen generate a 30-second ambient music track for a forest level
/audiogen read this line in George's voice: "Welcome, traveler."
/audiogen make a short door-creak sound effect
```

Standalone CLI:

```bash
node .claude/skills/audiogen/generate.cjs music "ambient forest loop" \
  --length-ms 30000 --output assets/audio/forest.mp3

node .claude/skills/audiogen/generate.cjs voice "Welcome, traveler." \
  --voice-id JBFqnCBsd6RMkjVDRZzb --output assets/audio/welcome.mp3

node .claude/skills/audiogen/generate.cjs sfx "short door creak" \
  --duration 1 --output assets/audio/door.mp3

node .claude/skills/audiogen/generate.cjs voices --limit 20
```

See `.claude/skills/audiogen/SKILL.md` for the full prompt reference and
`.claude/skills/audiogen/reference.md` for the preset/tag library.

## CI / standalone usage

`generate.cjs` is a zero-dep Node CLI; drop it into a GitHub Action or
any Node ≥ 20.14 environment:

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

## Licensing of generated audio

ElevenLabs' **paid tiers** grant perpetual commercial rights to audio
you generate; the **free tier** requires attribution
("Sound effect/voice/music by ElevenLabs"). Check your current plan at
<https://elevenlabs.io/pricing> before shipping output.

## Development

```bash
node --test tests/*.test.js      # unit tests only — fast
bash scripts/test-all.sh         # all suites (unit + e2e + build)
```

The E2E suite auto-skips when `ELEVENLABS_API_KEY` is unset, so the full
script is safe to run in CI without secrets.
