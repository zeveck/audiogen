// tests/history.test.js — appendHistory happy path + injected failing writeFn.
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const gen = path.resolve(__dirname, '..', '.claude', 'skills', 'audiogen', 'generate.cjs');
const { appendHistory } = require(gen);

describe('appendHistory', () => {
  let tmp;
  let origCwd;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-histtest-'));
    origCwd = process.cwd();
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writes one valid JSON line', () => {
    const record = {
      ts: '2026-04-16T12:00:00Z',
      id: 'abc123',
      type: 'music',
      prompt: 'epic theme',
      model_id: 'eleven_v3',
      output_path: 'assets/audio/music/epic-theme.mp3',
      output_format: 'mp3_44100_128',
      request_body: { prompt: 'epic theme' },
    };

    appendHistory(record);

    const histPath = path.join(tmp, '.audiogen-history.jsonl');
    assert.ok(fs.existsSync(histPath), 'history file should exist');

    const content = fs.readFileSync(histPath, 'utf8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 1);

    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.id, 'abc123');
    assert.equal(parsed.type, 'music');
    assert.equal(parsed.prompt, 'epic theme');
  });

  it('two calls produce two parseable lines', () => {
    const r1 = { ts: '1', id: 'a', type: 'music', prompt: 'one' };
    const r2 = { ts: '2', id: 'b', type: 'sfx', prompt: 'two' };

    appendHistory(r1);
    appendHistory(r2);

    const histPath = path.join(tmp, '.audiogen-history.jsonl');
    const lines = fs.readFileSync(histPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);

    const p1 = JSON.parse(lines[0]);
    const p2 = JSON.parse(lines[1]);
    assert.equal(p1.id, 'a');
    assert.equal(p2.id, 'b');
  });

  it('injected failing writeFn does not throw', () => {
    const failingWrite = () => {
      throw new Error('disk is on fire');
    };

    // Capture stderr to verify warning
    const origWrite = process.stderr.write;
    let captured = '';
    process.stderr.write = (s) => {
      captured += s;
    };

    try {
      // Must not throw
      appendHistory({ id: 'x', type: 'music', prompt: 'test' }, failingWrite);
      assert.ok(
        captured.includes('warning') && captured.includes('disk is on fire'),
        `stderr should contain warning about the error, got: ${captured}`
      );
    } finally {
      process.stderr.write = origWrite;
    }
  });
});
