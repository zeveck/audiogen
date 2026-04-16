// tests/sfx.test.js — Phase 4 sfx subcommand:
//   - pre-network validation (text, --output-format wav, --duration,
//     --prompt-influence, --loop+model-id)
//   - dry-run body / URL / output-path composition
//   - fetch-stubbed live calls: success, empty response, history record
//   - auto-versioning, default output path
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
  runSFX,
  validateSFXOptions,
  buildSFXRequest,
  parseArgs,
  SFX_DEFAULT_MODEL_ID,
  SFX_DEFAULT_OUTPUT_FORMAT,
  SFX_PROMPT_INFLUENCE_DEFAULT,
  SFX_WAV_REJECT_MSG,
  SFX_LOOP_MODEL_REJECT_MSG,
} = require(gen);

// ── Helpers (mirrors music.test.js / voice.test.js) ────────────────

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
    headers: { get: (k) => hdrs.get(String(k).toLowerCase()) || null },
    body: bodyStream,
    text: async () => (textValue === null ? '' : textValue),
  };
}

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

// ── validateSFXOptions ─────────────────────────────────────────────

describe('validateSFXOptions', () => {
  it('defaults: text-only → prompt_influence=0.3, loop=false, no duration', async () => {
    const parsed = parseArgs(['sfx', 'door', 'slam']);
    const r = await runCatching(() => {
      const opts = validateSFXOptions(parsed);
      assert.equal(opts.text, 'door slam');
      assert.equal(opts.promptInfluence, SFX_PROMPT_INFLUENCE_DEFAULT);
      assert.equal(opts.promptInfluence, 0.3);
      assert.equal(opts.loop, false);
      assert.equal(opts.modelId, SFX_DEFAULT_MODEL_ID);
      assert.equal(opts.modelId, 'eleven_text_to_sound_v2');
      assert.equal(opts.outputFormat, SFX_DEFAULT_OUTPUT_FORMAT);
      assert.equal(opts.outputFormat, 'mp3_44100_128');
      assert.equal(opts.durationSeconds, undefined);
    });
    assert.equal(r.exitCode, null, `should not exit; stderr=${r.stderr}`);
  });

  it('missing text (empty positionals) fails', async () => {
    const parsed = parseArgs(['sfx']);
    const r = await runCatching(() => validateSFXOptions(parsed));
    assert.equal(r.exitCode, 1);
    assert.ok(
      r.stderr.includes('sfx subcommand requires non-empty text'),
      `stderr=${r.stderr}`
    );
  });

  it('whitespace-only text fails', async () => {
    const parsed = parseArgs(['sfx', '   ']);
    const r = await runCatching(() => validateSFXOptions(parsed));
    assert.equal(r.exitCode, 1);
    assert.ok(r.stderr.includes('non-empty text'), `stderr=${r.stderr}`);
  });

  it('--duration 0.4 (below 0.5) fails with range hint', async () => {
    const parsed = parseArgs(['sfx', 'x', '--duration', '0.4']);
    const r = await runCatching(() => validateSFXOptions(parsed));
    assert.equal(r.exitCode, 1);
    assert.ok(
      r.stderr.includes('--duration must be in [0.5, 30]'),
      `stderr=${r.stderr}`
    );
  });

  it('--duration 31 (above 30) fails with range hint', async () => {
    const parsed = parseArgs(['sfx', 'x', '--duration', '31']);
    const r = await runCatching(() => validateSFXOptions(parsed));
    assert.equal(r.exitCode, 1);
    assert.ok(
      r.stderr.includes('--duration must be in [0.5, 30]'),
      `stderr=${r.stderr}`
    );
  });

  it('--duration non-numeric fails with range hint', async () => {
    const parsed = parseArgs(['sfx', 'x', '--duration', 'abc']);
    const r = await runCatching(() => validateSFXOptions(parsed));
    assert.equal(r.exitCode, 1);
    assert.ok(
      r.stderr.includes('--duration must be a number in [0.5, 30]'),
      `stderr=${r.stderr}`
    );
  });

  it('--duration boundary 0.5 accepted', async () => {
    const parsed = parseArgs(['sfx', 'x', '--duration', '0.5']);
    const r = await runCatching(() => {
      const opts = validateSFXOptions(parsed);
      assert.equal(opts.durationSeconds, 0.5);
    });
    assert.equal(r.exitCode, null, `stderr=${r.stderr}`);
  });

  it('--duration boundary 30 accepted', async () => {
    const parsed = parseArgs(['sfx', 'x', '--duration', '30']);
    const r = await runCatching(() => {
      const opts = validateSFXOptions(parsed);
      assert.equal(opts.durationSeconds, 30);
    });
    assert.equal(r.exitCode, null, `stderr=${r.stderr}`);
  });

  it('--duration omitted → durationSeconds undefined (API auto)', async () => {
    const parsed = parseArgs(['sfx', 'x']);
    const r = await runCatching(() => {
      const opts = validateSFXOptions(parsed);
      assert.equal(opts.durationSeconds, undefined);
    });
    assert.equal(r.exitCode, null);
  });

  it('--prompt-influence below 0 fails', async () => {
    const parsed = parseArgs(['sfx', 'x', '--prompt-influence', '-0.1']);
    const r = await runCatching(() => validateSFXOptions(parsed));
    assert.equal(r.exitCode, 1);
    assert.ok(
      r.stderr.includes('--prompt-influence must be in [0, 1]'),
      `stderr=${r.stderr}`
    );
  });

  it('--prompt-influence above 1 fails', async () => {
    const parsed = parseArgs(['sfx', 'x', '--prompt-influence', '1.1']);
    const r = await runCatching(() => validateSFXOptions(parsed));
    assert.equal(r.exitCode, 1);
    assert.ok(
      r.stderr.includes('--prompt-influence must be in [0, 1]'),
      `stderr=${r.stderr}`
    );
  });

  it('--prompt-influence non-numeric fails', async () => {
    const parsed = parseArgs(['sfx', 'x', '--prompt-influence', 'loud']);
    const r = await runCatching(() => validateSFXOptions(parsed));
    assert.equal(r.exitCode, 1);
    assert.ok(
      r.stderr.includes('--prompt-influence must be a number'),
      `stderr=${r.stderr}`
    );
  });

  it('--prompt-influence boundaries 0 and 1 accepted', async () => {
    for (const v of ['0', '1']) {
      const parsed = parseArgs(['sfx', 'x', '--prompt-influence', v]);
      const r = await runCatching(() => {
        const opts = validateSFXOptions(parsed);
        assert.equal(opts.promptInfluence, Number(v));
      });
      assert.equal(r.exitCode, null, `v=${v}; stderr=${r.stderr}`);
    }
  });

  it('--loop without explicit --model-id uses default v2 model and sets loop=true', async () => {
    const parsed = parseArgs(['sfx', 'x', '--loop']);
    const r = await runCatching(() => {
      const opts = validateSFXOptions(parsed);
      assert.equal(opts.loop, true);
      assert.equal(opts.modelId, 'eleven_text_to_sound_v2');
    });
    assert.equal(r.exitCode, null, `stderr=${r.stderr}`);
  });

  it('--loop with explicit non-v2 model fails with documented message', async () => {
    const parsed = parseArgs([
      'sfx', 'x', '--loop', '--model-id', 'eleven_text_to_sound_v1',
    ]);
    const r = await runCatching(() => validateSFXOptions(parsed));
    assert.equal(r.exitCode, 1);
    assert.ok(
      r.stderr.includes(SFX_LOOP_MODEL_REJECT_MSG),
      `stderr=${r.stderr}; expected: ${SFX_LOOP_MODEL_REJECT_MSG}`
    );
  });

  it('--loop with explicit v2 model accepted (sets loop=true)', async () => {
    const parsed = parseArgs([
      'sfx', 'x', '--loop', '--model-id', 'eleven_text_to_sound_v2',
    ]);
    const r = await runCatching(() => {
      const opts = validateSFXOptions(parsed);
      assert.equal(opts.loop, true);
      assert.equal(opts.modelId, 'eleven_text_to_sound_v2');
    });
    assert.equal(r.exitCode, null, `stderr=${r.stderr}`);
  });

  it('--output-format wav_44100 fails with documented message', async () => {
    const parsed = parseArgs(['sfx', 'x', '--output-format', 'wav_44100']);
    const r = await runCatching(() => validateSFXOptions(parsed));
    assert.equal(r.exitCode, 1);
    assert.ok(
      r.stderr.includes(SFX_WAV_REJECT_MSG),
      `stderr=${r.stderr}; expected: ${SFX_WAV_REJECT_MSG}`
    );
  });

  it('--output-format garbage (flac_48000) fails', async () => {
    const parsed = parseArgs(['sfx', 'x', '--output-format', 'flac_48000']);
    const r = await runCatching(() => validateSFXOptions(parsed));
    assert.equal(r.exitCode, 1);
    assert.ok(r.stderr.includes('invalid --output-format'), `stderr=${r.stderr}`);
  });
});

// ── buildSFXRequest ────────────────────────────────────────────────

describe('buildSFXRequest', () => {
  it('default body: text + model_id v2 + prompt_influence 0.3, no duration, no loop', () => {
    const { url, body } = buildSFXRequest({
      text: 'door slam',
      outputFormat: 'mp3_44100_128',
      modelId: 'eleven_text_to_sound_v2',
      promptInfluence: 0.3,
      loop: false,
    });
    assert.equal(
      url,
      'https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128'
    );
    assert.deepEqual(body, {
      text: 'door slam',
      model_id: 'eleven_text_to_sound_v2',
      prompt_influence: 0.3,
    });
    assert.ok(!('duration_seconds' in body));
    assert.ok(!('loop' in body));
  });

  it('body with all optional fields: duration_seconds + loop: true', () => {
    const { body } = buildSFXRequest({
      text: 'engine',
      outputFormat: 'mp3_44100_128',
      modelId: 'eleven_text_to_sound_v2',
      promptInfluence: 0.6,
      loop: true,
      durationSeconds: 2,
    });
    assert.deepEqual(body, {
      text: 'engine',
      model_id: 'eleven_text_to_sound_v2',
      prompt_influence: 0.6,
      duration_seconds: 2,
      loop: true,
    });
  });

  it('duration_seconds serialized as number (not string) in JSON', () => {
    const { body } = buildSFXRequest({
      text: 'x',
      outputFormat: 'mp3_44100_128',
      modelId: 'eleven_text_to_sound_v2',
      promptInfluence: 0.3,
      loop: false,
      durationSeconds: 2.0,
    });
    assert.equal(typeof body.duration_seconds, 'number');
    const json = JSON.stringify(body);
    assert.ok(
      /"duration_seconds":2(?!")/.test(json),
      `expected numeric duration_seconds in JSON; got: ${json}`
    );
  });

  it('URL-encodes output_format correctly', () => {
    const { url } = buildSFXRequest({
      text: 'x',
      outputFormat: 'pcm_44100',
      modelId: 'eleven_text_to_sound_v2',
      promptInfluence: 0.3,
      loop: false,
    });
    assert.ok(url.includes('output_format=pcm_44100'));
  });
});

// ── runSFX dry-run ─────────────────────────────────────────────────

describe('runSFX dry-run', () => {
  let tmp;
  let origCwd;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-sfx-dry-'));
    origCwd = process.cwd();
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('defaults: prints URL, body (no duration, no loop, p_i 0.3), output path; no network', async () => {
    const parsed = parseArgs(['sfx', 'door', 'slam', '--dry-run']);
    const fetchSpy = fetchScript([]);
    const stdout = makeCaptureStream();
    const r = await runCatching(() => runSFX(parsed, { fetchImpl: fetchSpy, stdout }));
    assert.equal(r.exitCode, null, `stderr=${r.stderr}`);
    assert.ok(stdout.buf.includes('audiogen dry-run (sfx)'), `stdout=${stdout.buf}`);
    assert.ok(
      stdout.buf.includes(
        'url: https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128'
      ),
      `stdout=${stdout.buf}`
    );
    assert.ok(stdout.buf.includes('"text":"door slam"'), `stdout=${stdout.buf}`);
    assert.ok(
      stdout.buf.includes('"model_id":"eleven_text_to_sound_v2"'),
      `stdout=${stdout.buf}`
    );
    assert.ok(stdout.buf.includes('"prompt_influence":0.3'), `stdout=${stdout.buf}`);
    // duration / loop absent
    assert.ok(!stdout.buf.includes('duration_seconds'), `stdout=${stdout.buf}`);
    assert.ok(!/"loop"\s*:/.test(stdout.buf), `stdout=${stdout.buf}`);
    // output path
    assert.ok(
      stdout.buf.includes(path.join('assets', 'audio', 'sfx', 'door-slam.mp3')),
      `stdout=${stdout.buf}`
    );
    // no fetch
    assert.equal(fetchSpy.calls.length, 0);
    // no history
    assert.ok(!fs.existsSync(path.join(tmp, '.audiogen-history.jsonl')));
    // no file written
    assert.ok(!fs.existsSync(path.join(tmp, 'assets')));
  });

  it('with --duration 2 --loop --prompt-influence 0.6: body contains all', async () => {
    const parsed = parseArgs([
      'sfx', 'engine', 'rev',
      '--duration', '2',
      '--loop',
      '--prompt-influence', '0.6',
      '--dry-run',
    ]);
    const stdout = makeCaptureStream();
    const r = await runCatching(() => runSFX(parsed, { stdout }));
    assert.equal(r.exitCode, null, `stderr=${r.stderr}`);
    assert.ok(stdout.buf.includes('"text":"engine rev"'), `stdout=${stdout.buf}`);
    assert.ok(stdout.buf.includes('"duration_seconds":2'), `stdout=${stdout.buf}`);
    assert.ok(stdout.buf.includes('"loop":true'), `stdout=${stdout.buf}`);
    assert.ok(stdout.buf.includes('"prompt_influence":0.6'), `stdout=${stdout.buf}`);
    assert.ok(
      stdout.buf.includes('"model_id":"eleven_text_to_sound_v2"'),
      `stdout=${stdout.buf}`
    );
  });

  it('AC dry-run body: --duration 2.0 serializes as number 2', async () => {
    // matches verbatim acceptance criterion
    const parsed = parseArgs([
      'sfx', 'door slam, reverb',
      '--duration', '2.0',
      '--dry-run',
    ]);
    const stdout = makeCaptureStream();
    const r = await runCatching(() => runSFX(parsed, { stdout }));
    assert.equal(r.exitCode, null, `stderr=${r.stderr}`);
    assert.ok(
      stdout.buf.includes(
        '{"text":"door slam, reverb","model_id":"eleven_text_to_sound_v2","prompt_influence":0.3,"duration_seconds":2}'
      ),
      `stdout=${stdout.buf}`
    );
  });
});

// ── runSFX live (fetch-stubbed) ────────────────────────────────────

describe('runSFX live (stubbed fetch)', () => {
  let tmp;
  let origCwd;
  let origKey;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-sfx-live-'));
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

  it('200 + octet-stream + body bytes: file created, bytes match, history record shape', async () => {
    const parsed = parseArgs(['sfx', 'door', 'slam', '--duration', '2.0', '--loop']);
    const bytes = Buffer.alloc(256, 0x55);
    const fetchImpl = fetchScript([
      makeResponse({ bodyBytes: bytes, headers: { 'xi-request-id': 'req-sfx-1' } }),
    ]);
    const stdout = makeCaptureStream();

    const r = await runCatching(() => runSFX(parsed, { fetchImpl, stdout }));
    assert.equal(r.exitCode, null, `stderr=${r.stderr}`);

    const outPath = path.join(tmp, 'assets', 'audio', 'sfx', 'door-slam.mp3');
    assert.ok(fs.existsSync(outPath), `expected file at ${outPath}`);
    const written = fs.readFileSync(outPath);
    assert.equal(written.length, 256);
    assert.deepEqual(written, bytes);

    // stdout prints the output path
    assert.ok(stdout.buf.includes(path.join('assets', 'audio', 'sfx', 'door-slam.mp3')));

    // history record
    const histPath = path.join(tmp, '.audiogen-history.jsonl');
    assert.ok(fs.existsSync(histPath), 'history file must exist');
    const lines = fs.readFileSync(histPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.type, 'sfx');
    assert.equal(rec.phase, 'sfx');
    assert.equal(rec.text, 'door slam');
    assert.equal(rec.duration_seconds, 2);
    assert.equal(rec.loop, true);
    assert.equal(rec.prompt_influence, 0.3);
    assert.equal(rec.model_id, 'eleven_text_to_sound_v2');
    assert.equal(rec.output_format, 'mp3_44100_128');
    assert.ok(rec.output_path.endsWith(path.join('assets', 'audio', 'sfx', 'door-slam.mp3')));
    assert.equal(rec.request_id, 'req-sfx-1');
    assert.equal(rec.bytes, 256);
    assert.ok(typeof rec.ts === 'string' && rec.ts.length > 0);

    // fetch called with expected URL + headers + body
    assert.equal(fetchImpl.calls.length, 1);
    const call = fetchImpl.calls[0];
    assert.equal(
      call.url,
      'https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128'
    );
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers['xi-api-key'], 'test-key');
    assert.equal(call.init.headers['content-type'], 'application/json');
    const sent = JSON.parse(call.init.body);
    assert.deepEqual(sent, {
      text: 'door slam',
      model_id: 'eleven_text_to_sound_v2',
      prompt_influence: 0.3,
      duration_seconds: 2,
      loop: true,
    });
  });

  it('default body composition (text only) sent on the wire', async () => {
    const parsed = parseArgs(['sfx', 'whoosh']);
    const bytes = Buffer.from('OK');
    const fetchImpl = fetchScript([makeResponse({ bodyBytes: bytes })]);
    const stdout = makeCaptureStream();

    const r = await runCatching(() => runSFX(parsed, { fetchImpl, stdout }));
    assert.equal(r.exitCode, null, `stderr=${r.stderr}`);

    const sent = JSON.parse(fetchImpl.calls[0].init.body);
    assert.deepEqual(sent, {
      text: 'whoosh',
      model_id: 'eleven_text_to_sound_v2',
      prompt_influence: 0.3,
    });
    assert.ok(!('duration_seconds' in sent));
    assert.ok(!('loop' in sent));

    // history reflects default loop=false and no duration_seconds
    const histPath = path.join(tmp, '.audiogen-history.jsonl');
    const rec = JSON.parse(fs.readFileSync(histPath, 'utf8').trim());
    assert.equal(rec.loop, false);
    assert.ok(!('duration_seconds' in rec));
  });

  it('200 + 0-byte body: file deleted, fails with empty-response message', async () => {
    const parsed = parseArgs(['sfx', 'silent', 'fx']);
    const fetchImpl = fetchScript([
      makeResponse({ bodyBytes: Buffer.alloc(0) }),
    ]);

    const r = await runCatching(() => runSFX(parsed, { fetchImpl }));
    assert.equal(r.exitCode, 1, `expected exit 1; stderr=${r.stderr}`);
    assert.ok(r.stderr.includes('empty audio response'), `stderr=${r.stderr}`);

    const outPath = path.join(tmp, 'assets', 'audio', 'sfx', 'silent-fx.mp3');
    assert.ok(!fs.existsSync(outPath), 'zero-byte file must be deleted');
  });

  it('default output path is assets/audio/sfx/<slug>.mp3', async () => {
    const parsed = parseArgs(['sfx', 'laser', 'zap']);
    const fetchImpl = fetchScript([makeResponse({ bodyBytes: Buffer.from('X') })]);
    const stdout = makeCaptureStream();

    const r = await runCatching(() => runSFX(parsed, { fetchImpl, stdout }));
    assert.equal(r.exitCode, null, `stderr=${r.stderr}`);

    const outPath = path.join(tmp, 'assets', 'audio', 'sfx', 'laser-zap.mp3');
    assert.ok(fs.existsSync(outPath), `expected ${outPath}; stdout=${stdout.buf}`);
  });

  it('auto-versioning: pre-existing fx.mp3 → writes fx-v2.mp3', async () => {
    const existingDir = path.join(tmp, 'assets', 'audio', 'sfx');
    fs.mkdirSync(existingDir, { recursive: true });
    fs.writeFileSync(path.join(existingDir, 'fx.mp3'), 'preexisting');

    const parsed = parseArgs(['sfx', 'fx']);
    const bytes = Buffer.from('NEW_V2');
    const fetchImpl = fetchScript([makeResponse({ bodyBytes: bytes })]);
    const stdout = makeCaptureStream();

    const r = await runCatching(() => runSFX(parsed, { fetchImpl, stdout }));
    assert.equal(r.exitCode, null, `stderr=${r.stderr}`);

    assert.equal(fs.readFileSync(path.join(existingDir, 'fx.mp3'), 'utf8'), 'preexisting');
    const v2 = path.join(existingDir, 'fx-v2.mp3');
    assert.ok(fs.existsSync(v2), `expected ${v2}`);
    assert.deepEqual(fs.readFileSync(v2), bytes);

    assert.ok(stdout.buf.includes('fx-v2.mp3'), `stdout=${stdout.buf}`);
    const histLines = fs
      .readFileSync(path.join(tmp, '.audiogen-history.jsonl'), 'utf8')
      .trim()
      .split('\n');
    const rec = JSON.parse(histLines[0]);
    assert.ok(rec.output_path.endsWith('fx-v2.mp3'));
  });

  it('history includes history_id / parent_id / duration_seconds when set', async () => {
    const parsed = parseArgs([
      'sfx', 'clank',
      '--duration', '1.5',
      '--history-id', 'iter-42',
      '--history-parent', 'parent-abc',
    ]);
    const fetchImpl = fetchScript([makeResponse({ bodyBytes: Buffer.from('Y') })]);
    const stdout = makeCaptureStream();

    const r = await runCatching(() => runSFX(parsed, { fetchImpl, stdout }));
    assert.equal(r.exitCode, null, `stderr=${r.stderr}`);

    const histPath = path.join(tmp, '.audiogen-history.jsonl');
    const rec = JSON.parse(fs.readFileSync(histPath, 'utf8').trim());
    assert.equal(rec.history_id, 'iter-42');
    assert.equal(rec.parent_id, 'parent-abc');
    assert.equal(rec.duration_seconds, 1.5);
  });
});

// ── CLI integration: parser-level rejections via real subprocess ──

describe('sfx CLI integration', () => {
  it('AC: dry-run body with --duration 2.0 prints exact JSON', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-sfx-cli-'));
    try {
      const out = execFileSync(
        process.execPath,
        [gen, 'sfx', 'door slam, reverb', '--duration', '2.0', '--dry-run'],
        { encoding: 'utf8', timeout: 5000, cwd: tmp }
      );
      assert.ok(out.includes('audiogen dry-run (sfx)'), `out=${out}`);
      assert.ok(
        out.includes(
          'url: https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128'
        ),
        `out=${out}`
      );
      assert.ok(
        out.includes(
          '{"text":"door slam, reverb","model_id":"eleven_text_to_sound_v2","prompt_influence":0.3,"duration_seconds":2}'
        ),
        `out=${out}`
      );
      // No fs side effects on dry-run
      assert.ok(!fs.existsSync(path.join(tmp, 'assets')));
      assert.ok(!fs.existsSync(path.join(tmp, '.audiogen-history.jsonl')));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('AC: --duration 31 exits 1 before network', () => {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [gen, 'sfx', 'boom', '--duration', '31', '--dry-run'],
          { encoding: 'utf8', timeout: 5000 }
        ),
      (e) => {
        assert.equal(e.status, 1);
        assert.ok(
          e.stderr.includes('--duration must be in [0.5, 30]'),
          `stderr=${e.stderr}`
        );
        return true;
      }
    );
  });

  it('--duration 0.4 exits 1 with range hint', () => {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [gen, 'sfx', 'x', '--duration', '0.4', '--dry-run'],
          { encoding: 'utf8', timeout: 5000 }
        ),
      (e) => {
        assert.equal(e.status, 1);
        assert.ok(
          e.stderr.includes('--duration must be in [0.5, 30]'),
          `stderr=${e.stderr}`
        );
        return true;
      }
    );
  });

  it('--loop --model-id eleven_text_to_sound_v1 exits 1 with documented message', () => {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            gen, 'sfx', 'x',
            '--loop',
            '--model-id', 'eleven_text_to_sound_v1',
            '--dry-run',
          ],
          { encoding: 'utf8', timeout: 5000 }
        ),
      (e) => {
        assert.equal(e.status, 1);
        assert.ok(
          e.stderr.includes(SFX_LOOP_MODEL_REJECT_MSG),
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
          [gen, 'sfx', 'x', '--output-format', 'wav_44100', '--dry-run'],
          { encoding: 'utf8', timeout: 5000 }
        ),
      (e) => {
        assert.equal(e.status, 1);
        assert.ok(
          e.stderr.includes(SFX_WAV_REJECT_MSG),
          `stderr=${e.stderr}`
        );
        return true;
      }
    );
  });

  it('--prompt-influence 1.5 exits 1 with range hint', () => {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [gen, 'sfx', 'x', '--prompt-influence', '1.5', '--dry-run'],
          { encoding: 'utf8', timeout: 5000 }
        ),
      (e) => {
        assert.equal(e.status, 1);
        assert.ok(
          e.stderr.includes('--prompt-influence must be in [0, 1]'),
          `stderr=${e.stderr}`
        );
        return true;
      }
    );
  });

  it('missing text (sfx with no positionals) exits 1', () => {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [gen, 'sfx', '--dry-run'],
          { encoding: 'utf8', timeout: 5000 }
        ),
      (e) => {
        assert.equal(e.status, 1);
        assert.ok(
          e.stderr.includes('non-empty text'),
          `stderr=${e.stderr}`
        );
        return true;
      }
    );
  });
});
