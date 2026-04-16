// tests/music.test.js — Phase 2 music subcommand:
//   - pre-network validation (--loop, --output-format, --length-ms, prompt)
//   - dry-run body / URL / output-path composition
//   - fetch-stubbed live calls: success, empty response, 4xx, 422 hint,
//     429 retry, auto-versioning
//
// Fetch is stubbed; no tests touch the real network.
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const gen = path.resolve(__dirname, '..', '.claude', 'skills', 'audiogen', 'generate.cjs');
const {
  runMusic,
  validateMusicOptions,
  buildMusicRequest,
  parseArgs,
  MUSIC_LOOP_REJECT_MSG,
  MUSIC_WAV_REJECT_MSG,
} = require(gen);

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Run a sync or async function that may call process.exit() via fail().
 * Captures stderr (from fail()) and the exit code. Stdout is NOT captured
 * globally; pass `deps.stdout = capture.stream` to runMusic instead. This
 * avoids interfering with node:test's own TAP output on process.stdout.
 *
 * Restores globals even on throw.
 */
async function runCatching(fn) {
  const origExit = process.exit;
  const origStderrWrite = process.stderr.write;

  let stderr = '';
  let exitCode = null;

  process.stderr.write = (chunk, enc, cb) => {
    stderr += typeof chunk === 'string' ? chunk : chunk.toString();
    if (typeof enc === 'function') enc();
    else if (typeof cb === 'function') cb();
    return true;
  };
  process.exit = (code) => {
    exitCode = code === undefined ? 0 : code;
    const e = new Error('__PROCESS_EXIT__');
    e.__exit = true;
    throw e;
  };

  let threw = null;
  try {
    await fn();
  } catch (e) {
    if (!e || !e.__exit) threw = e;
  } finally {
    process.exit = origExit;
    process.stderr.write = origStderrWrite;
  }
  return { stderr, exitCode, threw };
}

/** Make a writable-like object that collects writes into a string. */
function makeCaptureStream() {
  const s = {
    buf: '',
    write(chunk) {
      s.buf += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    },
  };
  return s;
}

/**
 * Build a stub fetch response. bodyBytes is a Buffer; for non-binary paths
 * pass a string via bodyText.
 */
function makeResponse({
  status = 200,
  statusText = 'OK',
  contentType = 'application/octet-stream',
  headers = {},
  bodyBytes = null,
  bodyText = null,
}) {
  const hdrs = new Map();
  hdrs.set('content-type', contentType);
  for (const [k, v] of Object.entries(headers)) hdrs.set(k.toLowerCase(), String(v));

  let bodyStream = null;
  let textValue = bodyText;
  if (bodyBytes !== null) {
    const u8 = bodyBytes instanceof Uint8Array ? bodyBytes : Buffer.from(bodyBytes);
    bodyStream = new ReadableStream({
      start(controller) {
        controller.enqueue(u8);
        controller.close();
      },
    });
    if (textValue === null) textValue = Buffer.from(u8).toString('utf8');
  }

  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: {
      get: (k) => hdrs.get(String(k).toLowerCase()) || null,
    },
    body: bodyStream,
    text: async () => (textValue === null ? '' : textValue),
  };
}

/**
 * Compose a fetch stub that returns a scripted sequence of responses.
 * Each script entry is either a response object (from makeResponse) or an
 * Error to throw.
 */
function fetchScript(responses) {
  const calls = [];
  let i = 0;
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (i >= responses.length) throw new Error('fetch called more times than scripted');
    const r = responses[i++];
    if (r instanceof Error) throw r;
    return r;
  };
  impl.calls = calls;
  return impl;
}

// ── validateMusicOptions / buildMusicRequest (unit, no process.exit) ──

describe('validateMusicOptions', () => {
  it('defaults: prompt-only → musicLengthMs=30000, no seed, no force_instrumental', async () => {
    const parsed = parseArgs(['music', 'chiptune', 'boss', 'battle']);
    const r = await runCatching(() => {
      const opts = validateMusicOptions(parsed);
      assert.equal(opts.prompt, 'chiptune boss battle');
      assert.equal(opts.musicLengthMs, 30000);
      assert.equal(opts.forceInstrumental, false);
      assert.equal(opts.seed, undefined);
      assert.equal(opts.outputFormat, 'mp3_44100_128');
    });
    assert.equal(r.exitCode, null, `should not exit; stderr=${r.stderr}`);
  });

  it('accepts all optional fields together', async () => {
    const parsed = parseArgs([
      'music', 'epic', 'theme',
      '--length-ms', '45000',
      '--seed', '42',
      '--force-instrumental',
      '--output-format', 'pcm_44100',
    ]);
    const r = await runCatching(() => {
      const opts = validateMusicOptions(parsed);
      assert.equal(opts.prompt, 'epic theme');
      assert.equal(opts.musicLengthMs, 45000);
      assert.equal(opts.seed, 42);
      assert.equal(opts.forceInstrumental, true);
      assert.equal(opts.outputFormat, 'pcm_44100');
    });
    assert.equal(r.exitCode, null);
  });

  it('boundaries: 3000 and 600000 accepted', async () => {
    for (const ms of ['3000', '600000']) {
      const parsed = parseArgs(['music', 'x', '--length-ms', ms]);
      const r = await runCatching(() => {
        const opts = validateMusicOptions(parsed);
        assert.equal(opts.musicLengthMs, Number(ms));
      });
      assert.equal(r.exitCode, null);
    }
  });

  it('--length-ms below 3000 fails with [3000, 600000] message', async () => {
    const parsed = parseArgs(['music', 'x', '--length-ms', '2000']);
    const r = await runCatching(() => validateMusicOptions(parsed));
    assert.equal(r.exitCode, 1);
    assert.ok(
      r.stderr.includes('music_length_ms must be in [3000, 600000]'),
      `stderr=${r.stderr}`
    );
  });

  it('--length-ms above 600000 fails', async () => {
    const parsed = parseArgs(['music', 'x', '--length-ms', '600001']);
    const r = await runCatching(() => validateMusicOptions(parsed));
    assert.equal(r.exitCode, 1);
    assert.ok(
      r.stderr.includes('music_length_ms must be in [3000, 600000]'),
      `stderr=${r.stderr}`
    );
  });

  it('--length-ms non-numeric fails pre-network', async () => {
    const parsed = parseArgs(['music', 'x', '--length-ms', 'abc']);
    const r = await runCatching(() => validateMusicOptions(parsed));
    assert.equal(r.exitCode, 1);
    assert.ok(r.stderr.includes('--length-ms must be an integer'), `stderr=${r.stderr}`);
  });

  it('--loop fails before network with documented message', async () => {
    const parsed = parseArgs(['music', 'x', '--loop']);
    const r = await runCatching(() => validateMusicOptions(parsed));
    assert.equal(r.exitCode, 1);
    assert.ok(
      r.stderr.includes(MUSIC_LOOP_REJECT_MSG),
      `stderr=${r.stderr}\nexpected: ${MUSIC_LOOP_REJECT_MSG}`
    );
  });

  it('--output-format wav_44100 fails with documented message', async () => {
    const parsed = parseArgs(['music', 'x', '--output-format', 'wav_44100']);
    const r = await runCatching(() => validateMusicOptions(parsed));
    assert.equal(r.exitCode, 1);
    assert.ok(
      r.stderr.includes(MUSIC_WAV_REJECT_MSG),
      `stderr=${r.stderr}\nexpected: ${MUSIC_WAV_REJECT_MSG}`
    );
  });

  it('--output-format garbage (flac_48000) fails', async () => {
    const parsed = parseArgs(['music', 'x', '--output-format', 'flac_48000']);
    const r = await runCatching(() => validateMusicOptions(parsed));
    assert.equal(r.exitCode, 1);
    assert.ok(r.stderr.includes('invalid --output-format'), `stderr=${r.stderr}`);
  });

  it('empty prompt after trim fails', async () => {
    const parsed = parseArgs(['music', '   ']);
    const r = await runCatching(() => validateMusicOptions(parsed));
    assert.equal(r.exitCode, 1);
    assert.ok(r.stderr.includes('non-empty prompt'), `stderr=${r.stderr}`);
  });

  it('--seed non-numeric fails', async () => {
    const parsed = parseArgs(['music', 'x', '--seed', 'not-a-number']);
    const r = await runCatching(() => validateMusicOptions(parsed));
    assert.equal(r.exitCode, 1);
    assert.ok(r.stderr.includes('--seed must be an integer'), `stderr=${r.stderr}`);
  });
});

describe('buildMusicRequest', () => {
  it('default body: prompt + music_length_ms only', () => {
    const { url, body } = buildMusicRequest({
      prompt: 'test',
      outputFormat: 'mp3_44100_128',
      musicLengthMs: 30000,
      forceInstrumental: false,
    });
    assert.equal(url, 'https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128');
    assert.deepEqual(body, { prompt: 'test', music_length_ms: 30000 });
    assert.ok(!('force_instrumental' in body));
    assert.ok(!('seed' in body));
  });

  it('with force_instrumental and seed', () => {
    const { body } = buildMusicRequest({
      prompt: 'instrumental',
      outputFormat: 'mp3_44100_128',
      musicLengthMs: 15000,
      forceInstrumental: true,
      seed: 42,
    });
    assert.deepEqual(body, {
      prompt: 'instrumental',
      music_length_ms: 15000,
      force_instrumental: true,
      seed: 42,
    });
  });

  it('URL-encodes output_format correctly', () => {
    const { url } = buildMusicRequest({
      prompt: 'x',
      outputFormat: 'pcm_44100',
      musicLengthMs: 3000,
      forceInstrumental: false,
    });
    assert.ok(url.includes('output_format=pcm_44100'));
  });
});

// ── Dry-run body assertion (in-process) ────────────────────────────

describe('runMusic dry-run', () => {
  let tmp;
  let origCwd;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-music-dry-'));
    origCwd = process.cwd();
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('prints URL, body, and output path; no network; no history', async () => {
    const parsed = parseArgs([
      'music', 'chiptune', 'boss', 'battle',
      '--length-ms', '15000',
      '--seed', '7',
      '--dry-run',
    ]);
    const fetchSpy = fetchScript([]); // must never be called
    const stdout = makeCaptureStream();
    const r = await runCatching(() =>
      runMusic(parsed, { fetchImpl: fetchSpy, stdout })
    );
    assert.equal(r.exitCode, null, `stderr=${r.stderr}`);
    assert.ok(stdout.buf.includes('audiogen dry-run (music)'), `stdout=${stdout.buf}`);
    assert.ok(
      stdout.buf.includes('url: https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128'),
      `stdout=${stdout.buf}`
    );
    assert.ok(
      stdout.buf.includes('"prompt":"chiptune boss battle"'),
      `stdout=${stdout.buf}`
    );
    assert.ok(stdout.buf.includes('"music_length_ms":15000'));
    assert.ok(stdout.buf.includes('"seed":7'));
    assert.ok(stdout.buf.includes('output: '));
    assert.ok(
      stdout.buf.includes(path.join('assets', 'audio', 'music', 'chiptune-boss-battle.mp3')),
      `stdout=${stdout.buf}`
    );
    // force_instrumental absent
    assert.ok(!stdout.buf.includes('force_instrumental'));
    // no fetch
    assert.equal(fetchSpy.calls.length, 0);
    // no history
    assert.ok(!fs.existsSync(path.join(tmp, '.audiogen-history.jsonl')));
  });

  it('dry-run with --force-instrumental includes it in body', async () => {
    const parsed = parseArgs([
      'music', 'ambient', 'pad',
      '--force-instrumental',
      '--dry-run',
    ]);
    const stdout = makeCaptureStream();
    const r = await runCatching(() => runMusic(parsed, { stdout }));
    assert.equal(r.exitCode, null, `stderr=${r.stderr}`);
    assert.ok(stdout.buf.includes('"force_instrumental":true'));
  });

  it('dry-run default length is 30000', async () => {
    const parsed = parseArgs(['music', 'default', 'length', '--dry-run']);
    const stdout = makeCaptureStream();
    const r = await runCatching(() => runMusic(parsed, { stdout }));
    assert.ok(stdout.buf.includes('"music_length_ms":30000'));
  });
});

// ── Live-call fetch stubs ──────────────────────────────────────────

describe('runMusic live (stubbed fetch)', () => {
  let tmp;
  let origCwd;
  let origKey;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-music-live-'));
    origCwd = process.cwd();
    origKey = process.env.ELEVENLABS_API_KEY;
    process.env.ELEVENLABS_API_KEY = 'test-key';
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(origCwd);
    if (origKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = origKey;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('200 + octet-stream + 1 KB body: file created, bytes match, history appended', async () => {
    const parsed = parseArgs(['music', 'epic', 'theme']);
    const bytes = Buffer.alloc(1024, 0x7f);
    const fetchImpl = fetchScript([
      makeResponse({ bodyBytes: bytes, headers: { 'xi-request-id': 'req-abc' } }),
    ]);
    const stdout = makeCaptureStream();

    const r = await runCatching(() => runMusic(parsed, { fetchImpl, stdout }));
    assert.equal(r.exitCode, null, `stderr=${r.stderr}`);

    const outPath = path.join(tmp, 'assets', 'audio', 'music', 'epic-theme.mp3');
    assert.ok(fs.existsSync(outPath), `expected file at ${outPath}`);
    const written = fs.readFileSync(outPath);
    assert.equal(written.length, 1024);
    assert.deepEqual(written, bytes);

    // stdout should print the output path
    assert.ok(stdout.buf.includes(path.join('assets', 'audio', 'music', 'epic-theme.mp3')));

    // history appended (one line)
    const histPath = path.join(tmp, '.audiogen-history.jsonl');
    assert.ok(fs.existsSync(histPath), 'history file must exist');
    const lines = fs.readFileSync(histPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.type, 'music');
    assert.equal(rec.phase, 'music');
    assert.equal(rec.prompt, 'epic theme');
    assert.equal(rec.music_length_ms, 30000);
    assert.equal(rec.output_format, 'mp3_44100_128');
    assert.ok(rec.output_path.endsWith(path.join('assets', 'audio', 'music', 'epic-theme.mp3')));
    assert.equal(rec.request_id, 'req-abc');
    assert.equal(rec.bytes, 1024);

    // Fetch called once with expected URL + headers
    assert.equal(fetchImpl.calls.length, 1);
    const call = fetchImpl.calls[0];
    assert.equal(call.url, 'https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers['xi-api-key'], 'test-key');
    assert.equal(call.init.headers['content-type'], 'application/json');
    const sent = JSON.parse(call.init.body);
    assert.deepEqual(sent, { prompt: 'epic theme', music_length_ms: 30000 });
  });

  it('200 + 0-byte body: file deleted, fails with empty-response message', async () => {
    const parsed = parseArgs(['music', 'silent', 'track']);
    const fetchImpl = fetchScript([
      makeResponse({ bodyBytes: Buffer.alloc(0) }),
    ]);

    const r = await runCatching(() => runMusic(parsed, { fetchImpl }));
    assert.equal(r.exitCode, 1, `expected exit 1; stderr=${r.stderr}`);
    assert.ok(r.stderr.includes('empty audio response'), `stderr=${r.stderr}`);

    // File must not exist
    const outPath = path.join(tmp, 'assets', 'audio', 'music', 'silent-track.mp3');
    assert.ok(!fs.existsSync(outPath), 'zero-byte file must be deleted');
  });

  it('400 JSON error body: fail with parsed detail surfaced', async () => {
    const parsed = parseArgs(['music', 'bad', 'req']);
    const errJson = JSON.stringify({ detail: { message: 'prompt too short' } });
    const fetchImpl = fetchScript([
      makeResponse({
        status: 400,
        statusText: 'Bad Request',
        contentType: 'application/json',
        bodyText: errJson,
      }),
    ]);

    const r = await runCatching(() => runMusic(parsed, { fetchImpl }));
    assert.equal(r.exitCode, 1);
    assert.ok(r.stderr.includes('ElevenLabs request failed (400)'), `stderr=${r.stderr}`);
    assert.ok(r.stderr.includes('prompt too short'), `stderr=${r.stderr}`);
  });

  it('422 with output_format in detail: hint mentions free tier', async () => {
    const parsed = parseArgs(['music', 'quality']);
    const errJson = JSON.stringify({
      detail: { message: 'output_format not allowed on your plan' },
    });
    const fetchImpl = fetchScript([
      makeResponse({
        status: 422,
        statusText: 'Unprocessable Entity',
        contentType: 'application/json',
        bodyText: errJson,
      }),
    ]);

    const r = await runCatching(() => runMusic(parsed, { fetchImpl }));
    assert.equal(r.exitCode, 1);
    assert.ok(r.stderr.includes('422'), `stderr=${r.stderr}`);
    assert.ok(
      /free-tier/i.test(r.stderr),
      `stderr should include free-tier hint, got: ${r.stderr}`
    );
    assert.ok(r.stderr.includes('mp3_44100_64'), `stderr=${r.stderr}`);
  });

  it('429 with retry-after: 1 then 200: second call succeeds, file written', async () => {
    const parsed = parseArgs(['music', 'retry', 'case']);
    const bytes = Buffer.from('RETRY_OK');
    const fetchImpl = fetchScript([
      makeResponse({
        status: 429,
        statusText: 'Too Many Requests',
        contentType: 'application/json',
        headers: { 'retry-after': '1' },
        bodyText: '{"detail":"rate limited"}',
      }),
      makeResponse({ bodyBytes: bytes }),
    ]);
    const stdout = makeCaptureStream();

    const r = await runCatching(() => runMusic(parsed, { fetchImpl, stdout }));
    assert.equal(r.exitCode, null, `stderr=${r.stderr}`);
    assert.equal(fetchImpl.calls.length, 2);

    const outPath = path.join(tmp, 'assets', 'audio', 'music', 'retry-case.mp3');
    assert.ok(fs.existsSync(outPath));
    const written = fs.readFileSync(outPath);
    assert.deepEqual(written, bytes);
  });

  it('auto-versioning: pre-existing x.mp3 → writes x-v2.mp3', async () => {
    const existingDir = path.join(tmp, 'assets', 'audio', 'music');
    fs.mkdirSync(existingDir, { recursive: true });
    fs.writeFileSync(path.join(existingDir, 'x.mp3'), 'preexisting');

    const parsed = parseArgs(['music', 'x']);
    const bytes = Buffer.from('NEW_VERSION');
    const fetchImpl = fetchScript([makeResponse({ bodyBytes: bytes })]);
    const stdout = makeCaptureStream();

    const r = await runCatching(() => runMusic(parsed, { fetchImpl, stdout }));
    assert.equal(r.exitCode, null, `stderr=${r.stderr}`);

    // original untouched
    assert.equal(fs.readFileSync(path.join(existingDir, 'x.mp3'), 'utf8'), 'preexisting');
    // -v2 created
    const v2 = path.join(existingDir, 'x-v2.mp3');
    assert.ok(fs.existsSync(v2), `expected ${v2}`);
    assert.deepEqual(fs.readFileSync(v2), bytes);

    // stdout and history reference v2 path
    assert.ok(stdout.buf.includes('x-v2.mp3'), `stdout=${stdout.buf}`);
    const histLines = fs
      .readFileSync(path.join(tmp, '.audiogen-history.jsonl'), 'utf8')
      .trim()
      .split('\n');
    const rec = JSON.parse(histLines[0]);
    assert.ok(rec.output_path.endsWith('x-v2.mp3'));
  });
});

// ── CLI integration: parser-level rejections via real subprocess ──

describe('music CLI integration', () => {
  it('--length-ms 2000 exits 1 with [3000, 600000] message', () => {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [gen, 'music', 'x', '--length-ms', '2000', '--dry-run'],
          { encoding: 'utf8', timeout: 5000 }
        ),
      (e) => {
        assert.equal(e.status, 1);
        assert.ok(
          e.stderr.includes('music_length_ms must be in [3000, 600000]'),
          `stderr=${e.stderr}`
        );
        return true;
      }
    );
  });

  it('--loop exits 1 with documented message before any network', () => {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [gen, 'music', 'x', '--loop', '--dry-run'],
          { encoding: 'utf8', timeout: 5000 }
        ),
      (e) => {
        assert.equal(e.status, 1);
        assert.ok(
          e.stderr.includes(MUSIC_LOOP_REJECT_MSG),
          `stderr=${e.stderr}`
        );
        return true;
      }
    );
  });

  it('--output-format wav_44100 exits 1 with WAV-not-supported message', () => {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [gen, 'music', 'x', '--output-format', 'wav_44100', '--dry-run'],
          { encoding: 'utf8', timeout: 5000 }
        ),
      (e) => {
        assert.equal(e.status, 1);
        assert.ok(
          e.stderr.includes(MUSIC_WAV_REJECT_MSG),
          `stderr=${e.stderr}`
        );
        return true;
      }
    );
  });

  it('dry-run acceptance: prints URL, body JSON, output path', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-music-cli-'));
    try {
      const out = execFileSync(
        process.execPath,
        [
          gen,
          'music',
          'chiptune boss battle',
          '--length-ms',
          '15000',
          '--seed',
          '7',
          '--dry-run',
        ],
        { encoding: 'utf8', timeout: 5000, cwd: tmp }
      );
      assert.ok(out.includes('audiogen dry-run (music)'), `out=${out}`);
      assert.ok(
        out.includes('url: https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128'),
        `out=${out}`
      );
      assert.ok(out.includes('"prompt":"chiptune boss battle"'));
      assert.ok(out.includes('"music_length_ms":15000'));
      assert.ok(out.includes('"seed":7'));
      assert.ok(out.includes(path.join('assets', 'audio', 'music', 'chiptune-boss-battle.mp3')));
      // No assets dir created on dry-run
      assert.ok(!fs.existsSync(path.join(tmp, 'assets')));
      // No history on dry-run
      assert.ok(!fs.existsSync(path.join(tmp, '.audiogen-history.jsonl')));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
