#!/usr/bin/env node
// audiogen-e2e.js -- End-to-end smoke tests against the live ElevenLabs API.
//
// Auto-skips when ELEVENLABS_API_KEY is unset or SKIP_E2E=1 so this file is
// safe to run in CI without secrets. When a key is present, generates a short
// music track, a TTS voice line, and a sound effect; asserts each file
// exists, is non-empty, and carries an MP3-ish header (ID3 tag OR a valid
// MPEG frame-sync byte pair).

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');

// ────────────────────────────────────────────────────────────────────
// Load .env so an exported shell env var isn't required — mirrors the
// behavior users expect from generate.cjs. Silent on missing file.
// ────────────────────────────────────────────────────────────────────

try {
  process.loadEnvFile();
} catch {
  // No .env in cwd — caller may have exported env vars directly; fine.
}

// ────────────────────────────────────────────────────────────────────
// Skip gate — before any test registration so the whole suite no-ops
// when the caller lacks an API key.
// ────────────────────────────────────────────────────────────────────

if (!process.env.ELEVENLABS_API_KEY || process.env.SKIP_E2E === '1') {
  console.log('[skipped] set ELEVENLABS_API_KEY to run end-to-end tests');
  process.exit(0);
}

// ────────────────────────────────────────────────────────────────────
// Setup — scratch dir + cleanup hooks.
// ────────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const GENERATE = path.join(REPO_ROOT, '.claude', 'skills', 'audiogen', 'generate.cjs');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-e2e-'));

function cleanup() {
  try {
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function run(args, opts = {}) {
  return execFileSync('node', [GENERATE, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

function assertMp3ish(filePath) {
  const stat = fs.statSync(filePath);
  assert.ok(stat.size > 0, `expected non-empty file at ${filePath}`);
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(3);
  try {
    fs.readSync(fd, buf, 0, 3, 0);
  } finally {
    fs.closeSync(fd);
  }
  const isId3 = buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33; // 'ID3'
  const isFrameSync = buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
  assert.ok(
    isId3 || isFrameSync,
    `expected MP3-ish header at ${filePath}, got bytes ${buf[0].toString(16)} ${buf[1].toString(16)} ${buf[2].toString(16)}`,
  );
}

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

test('music: generates a 3s track and writes a valid MP3 header', () => {
  const out = path.join(SCRATCH, 'music.mp3');
  run([
    'music',
    'short test tune',
    '--length-ms', '3000',
    '--output', out,
    '--force',
  ]);
  assert.ok(fs.existsSync(out), `expected ${out} to exist`);
  assertMp3ish(out);
});

test('voice: generates TTS from a short line via a stable public voice id', () => {
  const out = path.join(SCRATCH, 'voice.mp3');
  run([
    'voice',
    'Hello.',
    '--voice-id', 'JBFqnCBsd6RMkjVDRZzb',
    '--output', out,
    '--force',
  ]);
  assert.ok(fs.existsSync(out), `expected ${out} to exist`);
  assertMp3ish(out);
});

test('sfx: generates a 1s sound effect and writes a valid MP3 header', () => {
  const out = path.join(SCRATCH, 'sfx.mp3');
  run([
    'sfx',
    'short door click',
    '--duration', '1',
    '--output', out,
    '--force',
  ]);
  assert.ok(fs.existsSync(out), `expected ${out} to exist`);
  assertMp3ish(out);
});

test('voices: --refresh --limit 5 returns non-empty output', () => {
  const stdout = run(['voices', '--limit', '5', '--refresh']);
  assert.ok(stdout.trim().length > 0, 'expected non-empty voices output');
});
