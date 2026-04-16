// tests/paths.test.js — slugify + resolveOutputPath auto-versioning,
// force override, empty-slug timestamp fallback, dry-run tmpdir test.
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const gen = path.resolve(__dirname, '..', '.claude', 'skills', 'audiogen', 'generate.cjs');
const { slugify, resolveOutputPath, extFromOutputFormat } = require(gen);

// ── slugify ─────────────────────────────────────────────────────────

describe('slugify', () => {
  it('basic ASCII prompt', () => {
    assert.equal(slugify('Epic Battle Theme'), 'epic-battle-theme');
  });

  it('all-punctuation collapses away and falls back to timestamp', () => {
    // After collapse + trim, all-punctuation yields empty, which triggers
    // the timestamp fallback.
    const s = slugify('!!!...???');
    assert.match(s, /^audio-\d{8}-\d{6}$/);
  });

  it('empty input produces timestamp fallback matching /^audio-\\d{8}-\\d{6}$/', () => {
    const s = slugify('');
    assert.match(s, /^audio-\d{8}-\d{6}$/);
  });

  it('all-punctuation produces timestamp fallback', () => {
    const s = slugify('!!!...???');
    assert.match(s, /^audio-\d{8}-\d{6}$/);
  });

  it('Japanese/emoji input produces timestamp fallback', () => {
    const s1 = slugify('\u6226\u95D8\u97F3\u697D'); // 戦闘音楽
    assert.match(s1, /^audio-\d{8}-\d{6}$/);

    const s2 = slugify('\uD83D\uDD25\uD83C\uDFB5\u2728');
    assert.match(s2, /^audio-\d{8}-\d{6}$/);
  });

  it('truncates to 40 chars before slugifying', () => {
    const long = 'a'.repeat(60);
    const s = slugify(long);
    assert.ok(s.length <= 40);
  });

  it('strips leading/trailing dashes', () => {
    assert.equal(slugify('  --hello--  '), 'hello');
  });
});

// ── extFromOutputFormat ────────────────────────────────────────────

describe('extFromOutputFormat', () => {
  it('mp3_44100_128 -> mp3', () => assert.equal(extFromOutputFormat('mp3_44100_128'), 'mp3'));
  it('pcm_16000 -> wav', () => assert.equal(extFromOutputFormat('pcm_16000'), 'wav'));
  it('wav_44100 -> wav', () => assert.equal(extFromOutputFormat('wav_44100'), 'wav'));
  it('opus_48000 -> opus', () => assert.equal(extFromOutputFormat('opus_48000'), 'opus'));
  it('ulaw_8000 -> raw', () => assert.equal(extFromOutputFormat('ulaw_8000'), 'raw'));
  it('alaw_8000 -> raw', () => assert.equal(extFromOutputFormat('alaw_8000'), 'raw'));
  it('unknown -> bin', () => assert.equal(extFromOutputFormat('flac_48000'), 'bin'));
  it('null -> bin', () => assert.equal(extFromOutputFormat(null), 'bin'));
});

// ── resolveOutputPath ──────────────────────────────────────────────

describe('resolveOutputPath', () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-pathtest-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('default dir per type', () => {
    const p = resolveOutputPath({
      type: 'music',
      prompt: 'test',
      outputFormat: 'mp3_44100_128',
    });
    assert.equal(p, path.join('assets', 'audio', 'music', 'test.mp3'));
  });

  it('honors --output directory', () => {
    fs.mkdirSync(path.join(tmp, 'mydir'), { recursive: true });
    const p = resolveOutputPath({
      type: 'sfx',
      prompt: 'boom',
      outputOption: path.join(tmp, 'mydir'),
      outputFormat: 'mp3_44100_128',
    });
    assert.equal(p, path.join(tmp, 'mydir', 'boom.mp3'));
  });

  it('honors --output directory (trailing slash)', () => {
    const p = resolveOutputPath({
      type: 'sfx',
      prompt: 'boom',
      outputOption: path.join(tmp, 'newdir/'),
      outputFormat: 'mp3_44100_128',
    });
    assert.equal(p, path.join(tmp, 'newdir', 'boom.mp3'));
  });

  it('honors --output file verbatim', () => {
    const p = resolveOutputPath({
      type: 'music',
      prompt: 'test',
      outputOption: path.join(tmp, 'my-file.wav'),
      outputFormat: 'mp3_44100_128',
    });
    assert.equal(p, path.join(tmp, 'my-file.wav'));
  });

  it('auto-bumps to -v2, -v3 when file exists', () => {
    const base = path.join(tmp, 'assets', 'audio', 'music', 'test.mp3');
    fs.mkdirSync(path.dirname(base), { recursive: true });
    fs.writeFileSync(base, 'fake');

    const origCwd = process.cwd();
    process.chdir(tmp);

    const p1 = resolveOutputPath({
      type: 'music',
      prompt: 'test',
      outputFormat: 'mp3_44100_128',
    });
    assert.equal(p1, path.join('assets', 'audio', 'music', 'test-v2.mp3'));

    // Create -v2 and check -v3
    fs.writeFileSync(path.join(tmp, p1), 'fake2');
    const p2 = resolveOutputPath({
      type: 'music',
      prompt: 'test',
      outputFormat: 'mp3_44100_128',
    });
    assert.equal(p2, path.join('assets', 'audio', 'music', 'test-v3.mp3'));

    process.chdir(origCwd);
  });

  it('returns base when force is true even if file exists', () => {
    const base = path.join(tmp, 'assets', 'audio', 'sfx', 'boom.mp3');
    fs.mkdirSync(path.dirname(base), { recursive: true });
    fs.writeFileSync(base, 'fake');

    const origCwd = process.cwd();
    process.chdir(tmp);

    const p = resolveOutputPath({
      type: 'sfx',
      prompt: 'boom',
      outputFormat: 'mp3_44100_128',
      force: true,
    });
    assert.equal(p, path.join('assets', 'audio', 'sfx', 'boom.mp3'));

    process.chdir(origCwd);
  });

  it('empty-slug fallback matches timestamp regex', () => {
    const p = resolveOutputPath({
      type: 'music',
      prompt: '',
      outputFormat: 'mp3_44100_128',
    });
    const name = path.basename(p, '.mp3');
    assert.match(name, /^audio-\d{8}-\d{6}$/);
    assert.ok(p.startsWith(path.join('assets', 'audio', 'music')));
  });
});

describe('dry-run tmpdir test', () => {
  it('dry-run does not create assets/ in the tmpdir', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-dryrun-'));
    try {
      execFileSync(
        process.execPath,
        [gen, 'music', 'test prompt', '--dry-run'],
        {
          encoding: 'utf8',
          timeout: 5000,
          cwd: tmp,
          env: { ...process.env, ELEVENLABS_API_KEY: undefined },
        }
      );
      // Verify no assets/ directory was created
      assert.ok(
        !fs.existsSync(path.join(tmp, 'assets')),
        'dry-run must not create assets/ directory'
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
