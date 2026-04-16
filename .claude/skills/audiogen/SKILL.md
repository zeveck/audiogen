---
name: audiogen
description: Generate game audio (music, voices, sound effects) via ElevenLabs.
disable-model-invocation: false
allowed-tools: Bash(node */generate.cjs *)
argument-hint: <music|voice|sfx|voices> <description> [--voice-id ID] [--length-ms MS] [--duration SEC] [--output PATH]
---

# audiogen

Generate game audio (music, voices, sound effects) via ElevenLabs.

Phase 1 scaffold. Real prose lands in Phase 5.

## Prerequisites

- Node.js >= 20.14 (for `process.loadEnvFile`).
- `ELEVENLABS_API_KEY` exported in the shell, or set in a `.env` file in the
  project root. Shell-exported values take precedence over `.env` values.

## Usage

    node .claude/skills/audiogen/generate.cjs <music|voice|sfx|voices> ... [options]

Run with `--help` for the full flag surface.
