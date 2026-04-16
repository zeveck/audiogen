// tests/voice.test.js — Phase 3 voice subcommand:
//   - text validation (empty, > 40k)
//   - voice-id resolution (name → id, disambiguation, shadowing, passthrough, no match)
//   - voice_id in URL path (not body)
//   - body shape (text required, model_id default, seed + voice_settings)
//   - output format default, WAV allowed
//   - default output path assets/audio/voice/<slug>.<ext> + auto-versioning
//   - dry-run output
//   - history record shape
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
  runTTS,
  resolveVoiceId,
  validateVoiceOptions,
  buildVoiceRequest,
  parseArgs,
  VOICE_ID_RE,
  VOICE_TEXT_MAX_LEN,
  VOICE_DEFAULT_MODEL_ID,
  VOICE_DEFAULT_OUTPUT_FORMAT,
} = require(gen);

// ── Helpers (mirrors music.test.js) ────────────────────────────────

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

function writeCache(tmp, voices) {
  const cachePath = path.join(tmp, '.audiogen-voices.json');
  fs.writeFileSync(
    cachePath,
    JSON.stringify({ fetched_at: new Date().toISOString(), voices }, null, 2)
  );
  return cachePath;
}

// ── resolveVoiceId (unit) ──────────────────────────────────────────

describe('resolveVoiceId', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-voice-resolve-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('undefined/empty input throws VOICE_ID_REQUIRED', () => {
    const cache = path.join(tmp, '.audiogen-voices.json');
    assert.throws(
      () => resolveVoiceId(undefined, cache),
      (e) => e.code === 'VOICE_ID_REQUIRED'
    );
    assert.throws(
      () => resolveVoiceId('', cache),
      (e) => e.code === 'VOICE_ID_REQUIRED'
    );
    assert.throws(
      () => resolveVoiceId('   ', cache),
      (e) => e.code === 'VOICE_ID_REQUIRED'
    );
  });

  it('cache missing + non-ID input throws NO_CACHE', () => {
    const cache = path.join(tmp, '.audiogen-voices.json');
    assert.throws(
      () => resolveVoiceId('Rachel', cache),
      (e) => e.code === 'NO_CACHE' && /No voice cache/.test(e.message)
    );
  });

  it('cache missing + 20-char ID → passthrough OK', () => {
    const cache = path.join(tmp, '.audiogen-voices.json');
    const id = 'JBFqnCBsd6RMkjVDRZzb';
    assert.ok(VOICE_ID_RE.test(id));
    const out = resolveVoiceId(id, cache);
    assert.equal(out.voiceId, id);
  });

  it('name match in fixture cache resolves correctly', () => {
    const cache = writeCache(tmp, [
      { voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel' },
      { voice_id: 'ABCDEFGH1234567890zz', name: 'Adam' },
    ]);
    const out = resolveVoiceId('Rachel', cache);
    assert.equal(out.voiceId, '21m00Tcm4TlvDq8ikWAM');
    assert.equal(out.voiceName, 'Rachel');
    assert.equal(out.shadowWarning, undefined);
  });

  it('name match is case-insensitive', () => {
    const cache = writeCache(tmp, [
      { voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel' },
    ]);
    assert.equal(resolveVoiceId('rachel', cache).voiceId, '21m00Tcm4TlvDq8ikWAM');
    assert.equal(resolveVoiceId('RACHEL', cache).voiceId, '21m00Tcm4TlvDq8ikWAM');
  });

  it('name trims whitespace on input', () => {
    const cache = writeCache(tmp, [
      { voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel' },
    ]);
    const out = resolveVoiceId('  Rachel  ', cache);
    assert.equal(out.voiceId, '21m00Tcm4TlvDq8ikWAM');
  });

  it('duplicate names → DISAMBIGUATION error listing all matches', () => {
    const cache = writeCache(tmp, [
      { voice_id: 'AAAAAAAAAAAAAAAAAAAA', name: 'Adam', category: 'premade',
        labels: { accent: 'American', gender: 'male' } },
      { voice_id: 'BBBBBBBBBBBBBBBBBBBB', name: 'Adam', category: 'cloned',
        labels: { accent: 'British' } },
    ]);
    assert.throws(
      () => resolveVoiceId('Adam', cache),
      (e) => {
        assert.equal(e.code, 'DISAMBIGUATION');
        assert.equal(e.matches.length, 2);
        assert.ok(e.matches.find((m) => m.voice_id === 'AAAAAAAAAAAAAAAAAAAA'));
        assert.ok(e.matches.find((m) => m.voice_id === 'BBBBBBBBBBBBBBBBBBBB'));
        return true;
      }
    );
  });

  it('shadowing: 20-char input that also matches a cached name → warning', () => {
    const cache = writeCache(tmp, [
      { voice_id: 'realidAAAAAAAAAAAAAA', name: 'abcdefghij1234567890' },
    ]);
    const id = 'abcdefghij1234567890';
    assert.ok(VOICE_ID_RE.test(id), 'test fixture: 20-char alphanumeric');
    const out = resolveVoiceId(id, cache);
    assert.equal(out.voiceId, 'realidAAAAAAAAAAAAAA');
    assert.ok(typeof out.shadowWarning === 'string' && out.shadowWarning.length > 0);
    assert.ok(
      out.shadowWarning.includes('voice-id pattern') ||
        out.shadowWarning.includes('cached voice name')
    );
  });

  it('zero name match + non-ID input → NO_MATCH', () => {
    const cache = writeCache(tmp, [
      { voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel' },
    ]);
    assert.throws(
      () => resolveVoiceId('Donny', cache),
      (e) => e.code === 'NO_MATCH' && /No voice named/.test(e.message)
    );
  });

  it('zero name match + 20-char ID → passthrough', () => {
    const cache = writeCache(tmp, [
      { voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel' },
    ]);
    const out = resolveVoiceId('XXXXXXXXXXXXXXXXXXXX', cache);
    assert.equal(out.voiceId, 'XXXXXXXXXXXXXXXXXXXX');
  });

  it('corrupt cache JSON treated as cache-miss', () => {
    const cache = path.join(tmp, '.audiogen-voices.json');
    fs.writeFileSync(cache, '{not valid json');
    // missing cache + 20-char → passthrough
    assert.equal(
      resolveVoiceId('XXXXXXXXXXXXXXXXXXXX', cache).voiceId,
      'XXXXXXXXXXXXXXXXXXXX'
    );
    // missing cache + non-ID → NO_CACHE
    assert.throws(
      () => resolveVoiceId('Rachel', cache),
      (e) => e.code === 'NO_CACHE'
    );
  });
});

// ── validateVoiceOptions / buildVoiceRequest ────────────────────────

describe('validateVoiceOptions', () => {
  let tmp, origCwd;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-voice-validate-'));
    origCwd = process.cwd();
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('defaults: 20-char ID, no cache → modelId default, outputFormat default', async () => {
    const parsed = parseArgs(['voice', 'hello', 'world', '--voice-id', 'JBFqnCBsd6RMkjVDRZzb']);
    const r = await runCatching(() => {
      const opts = validateVoiceOptions(parsed);
      assert.equal(opts.text, 'hello world');
      assert.equal(opts.voiceId, 'JBFqnCBsd6RMkjVDRZzb');
      assert.equal(opts.modelId, VOICE_DEFAULT_MODEL_ID);
      assert.equal(opts.outputFormat, VOICE_DEFAULT_OUTPUT_FORMAT);
      assert.equal(opts.voiceSettings, undefined);
    });
    assert.equal(r.exitCode, null, `stderr=${r.stderr}`);
  });

  it('empty text fails', async () => {
    const parsed = parseArgs(['voice', '   ', '--voice-id', 'JBFqnCBsd6RMkjVDRZzb']);
    const r = await runCatching(() => validateVoiceOptions(parsed));
    assert.equal(r.exitCode, 1);
    assert.ok(/non-empty text/.test(r.stderr), r.stderr);
  });

  it(`text > ${VOICE_TEXT_MAX_LEN} chars is rejected`, async () => {
    const big = 'a'.repeat(VOICE_TEXT_MAX_LEN + 1);
    const parsed = parseArgs(['voice', big, '--voice-id', 'JBFqnCBsd6RMkjVDRZzb']);
    const r = await runCatching(() => validateVoiceOptions(parsed));
    assert.equal(r.exitCode, 1);
    assert.ok(
      r.stderr.includes(`max is ${VOICE_TEXT_MAX_LEN}`),
      `stderr=${r.stderr}`
    );
  });

  it(`text exactly ${VOICE_TEXT_MAX_LEN} chars is accepted`, async () => {
    const big = 'a'.repeat(VOICE_TEXT_MAX_LEN);
    const parsed = parseArgs(['voice', big, '--voice-id', 'JBFqnCBsd6RMkjVDRZzb']);
    const r = await runCatching(() => {
      const opts = validateVoiceOptions(parsed);
      assert.equal(opts.text.length, VOICE_TEXT_MAX_LEN);
    });
    assert.equal(r.exitCode, null, `stderr=${r.stderr}`);
  });

  it('WAV output format accepted for voice', async () => {
    const parsed = parseArgs([
      'voice',
      'hi',
      '--voice-id',
      'JBFqnCBsd6RMkjVDRZzb',
      '--output-format',
      'pcm_44100',
    ]);
    const r = await runCatching(() => {
      const opts = validateVoiceOptions(parsed);
      assert.equal(opts.outputFormat, 'pcm_44100');
    });
    assert.equal(r.exitCode, null);
  });

  it('garbage output format rejected', async () => {
    const parsed = parseArgs([
      'voice',
      'hi',
      '--voice-id',
      'JBFqnCBsd6RMkjVDRZzb',
      '--output-format',
      'flac_48000',
    ]);
    const r = await runCatching(() => validateVoiceOptions(parsed));
    assert.equal(r.exitCode, 1);
    assert.ok(/invalid --output-format/.test(r.stderr), r.stderr);
  });

  it('voice_settings only includes user-specified fields', async () => {
    const parsed = parseArgs([
      'voice',
      'hi',
      '--voice-id',
      'JBFqnCBsd6RMkjVDRZzb',
      '--stability',
      '0.4',
      '--speed',
      '1.1',
    ]);
    const r = await runCatching(() => {
      const opts = validateVoiceOptions(parsed);
      assert.deepEqual(opts.voiceSettings, { stability: 0.4, speed: 1.1 });
    });
    assert.equal(r.exitCode, null, r.stderr);
  });

  it('disambiguation surfaces matches to stderr', async () => {
    writeCache(tmp, [
      { voice_id: 'AAAAAAAAAAAAAAAAAAAA', name: 'Adam', category: 'premade',
        labels: { accent: 'American' } },
      { voice_id: 'BBBBBBBBBBBBBBBBBBBB', name: 'Adam', category: 'cloned',
        labels: { accent: 'British' } },
    ]);
    const parsed = parseArgs(['voice', 'hi', '--voice-id', 'Adam']);
    const r = await runCatching(() => validateVoiceOptions(parsed));
    assert.equal(r.exitCode, 1);
    assert.ok(r.stderr.includes('AAAAAAAAAAAAAAAAAAAA'), r.stderr);
    assert.ok(r.stderr.includes('BBBBBBBBBBBBBBBBBBBB'), r.stderr);
  });
});

describe('buildVoiceRequest', () => {
  it('URL contains voice_id path segment and output_format; body has text + model_id only', () => {
    const { url, body } = buildVoiceRequest({
      text: 'Halt!',
      voiceId: 'JBFqnCBsd6RMkjVDRZzb',
      modelId: VOICE_DEFAULT_MODEL_ID,
      outputFormat: 'mp3_44100_128',
    });
    assert.equal(
      url,
      'https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=mp3_44100_128'
    );
    assert.deepEqual(body, { text: 'Halt!', model_id: VOICE_DEFAULT_MODEL_ID });
    assert.ok(!('voice_id' in body));
  });

  it('language_code, voice_settings, seed included when set', () => {
    const { body } = buildVoiceRequest({
      text: 'x',
      voiceId: 'JBFqnCBsd6RMkjVDRZzb',
      modelId: 'eleven_multilingual_v2',
      outputFormat: 'mp3_44100_128',
      languageCode: 'en',
      voiceSettings: { stability: 0.5 },
      seed: 7,
    });
    assert.equal(body.language_code, 'en');
    assert.deepEqual(body.voice_settings, { stability: 0.5 });
    assert.equal(body.seed, 7);
  });
});

// ── runTTS dry-run ─────────────────────────────────────────────────

describe('runTTS dry-run', () => {
  let tmp, origCwd;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-voice-dry-'));
    origCwd = process.cwd();
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('prints URL with voice_id in path + body JSON + slug-derived output path; no fetch', async () => {
    const parsed = parseArgs([
      'voice',
      'Halt!',
      '--voice-id',
      'JBFqnCBsd6RMkjVDRZzb',
      '--dry-run',
    ]);
    const fetchSpy = fetchScript([]);
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const r = await runCatching(() =>
      runTTS(parsed, { fetchImpl: fetchSpy, stdout, stderr })
    );
    assert.equal(r.exitCode, null, r.stderr);
    assert.ok(stdout.buf.includes('audiogen dry-run (voice)'));
    assert.ok(
      stdout.buf.includes(
        'url: https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=mp3_44100_128'
      ),
      stdout.buf
    );
    assert.ok(stdout.buf.includes('"text":"Halt!"'));
    assert.ok(stdout.buf.includes(`"model_id":"${VOICE_DEFAULT_MODEL_ID}"`));
    assert.ok(
      stdout.buf.includes(path.join('assets', 'audio', 'voice', 'halt.mp3')),
      stdout.buf
    );
    assert.equal(fetchSpy.calls.length, 0);
    assert.ok(!fs.existsSync(path.join(tmp, '.audiogen-history.jsonl')));
  });

  it('dry-run with cache-resolved voice name uses resolved ID in URL path', async () => {
    writeCache(tmp, [
      { voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel' },
    ]);
    const parsed = parseArgs([
      'voice',
      'hi',
      '--voice-id',
      'Rachel',
      '--dry-run',
    ]);
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const r = await runCatching(() => runTTS(parsed, { stdout, stderr }));
    assert.equal(r.exitCode, null, r.stderr);
    assert.ok(
      stdout.buf.includes('/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM?'),
      stdout.buf
    );
  });

  it('WAV output format yields .wav output path', async () => {
    const parsed = parseArgs([
      'voice',
      'hi',
      '--voice-id',
      'JBFqnCBsd6RMkjVDRZzb',
      '--output-format',
      'pcm_44100',
      '--dry-run',
    ]);
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const r = await runCatching(() => runTTS(parsed, { stdout, stderr }));
    assert.equal(r.exitCode, null, r.stderr);
    assert.ok(
      stdout.buf.includes(path.join('assets', 'audio', 'voice', 'hi.wav')),
      stdout.buf
    );
  });
});

// ── runTTS live (fetch-stubbed) ────────────────────────────────────

describe('runTTS live (stubbed fetch)', () => {
  let tmp, origCwd, origKey;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-voice-live-'));
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

  it('200 octet-stream: file created, history record has phase=voice and voice_id', async () => {
    const parsed = parseArgs([
      'voice',
      'Halt!',
      '--voice-id',
      'JBFqnCBsd6RMkjVDRZzb',
    ]);
    const bytes = Buffer.alloc(256, 0x5a);
    const fetchImpl = fetchScript([
      makeResponse({ bodyBytes: bytes, headers: { 'xi-request-id': 'req-v' } }),
    ]);
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();

    const r = await runCatching(() =>
      runTTS(parsed, { fetchImpl, stdout, stderr })
    );
    assert.equal(r.exitCode, null, r.stderr);

    const outPath = path.join(tmp, 'assets', 'audio', 'voice', 'halt.mp3');
    assert.ok(fs.existsSync(outPath), outPath);
    const written = fs.readFileSync(outPath);
    assert.equal(written.length, 256);

    // Assert fetch URL used voice_id in PATH (not body).
    assert.equal(fetchImpl.calls.length, 1);
    const call = fetchImpl.calls[0];
    assert.equal(
      call.url,
      'https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=mp3_44100_128'
    );
    const sent = JSON.parse(call.init.body);
    assert.equal(sent.text, 'Halt!');
    assert.equal(sent.model_id, VOICE_DEFAULT_MODEL_ID);
    assert.ok(!('voice_id' in sent), `voice_id must not appear in body; got ${call.init.body}`);

    // History record shape.
    const hist = fs.readFileSync(
      path.join(tmp, '.audiogen-history.jsonl'),
      'utf8'
    ).trim().split('\n');
    assert.equal(hist.length, 1);
    const rec = JSON.parse(hist[0]);
    assert.equal(rec.type, 'voice');
    assert.equal(rec.phase, 'voice');
    assert.equal(rec.voice_id, 'JBFqnCBsd6RMkjVDRZzb');
    assert.equal(rec.text, 'Halt!');
    assert.equal(rec.model_id, VOICE_DEFAULT_MODEL_ID);
    assert.equal(rec.output_format, 'mp3_44100_128');
    assert.ok(rec.output_path.endsWith(path.join('assets', 'audio', 'voice', 'halt.mp3')));
    assert.equal(rec.request_id, 'req-v');
    assert.equal(rec.bytes, 256);
  });

  it('cache-resolved name writes history with voice_name + uses resolved ID in URL', async () => {
    writeCache(tmp, [
      { voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel' },
    ]);
    const parsed = parseArgs(['voice', 'hello', '--voice-id', 'Rachel']);
    const bytes = Buffer.from('OK');
    const fetchImpl = fetchScript([makeResponse({ bodyBytes: bytes })]);
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();

    const r = await runCatching(() => runTTS(parsed, { fetchImpl, stdout, stderr }));
    assert.equal(r.exitCode, null, r.stderr);
    assert.ok(fetchImpl.calls[0].url.includes('/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM?'));

    const hist = fs.readFileSync(path.join(tmp, '.audiogen-history.jsonl'), 'utf8');
    const rec = JSON.parse(hist.trim().split('\n')[0]);
    assert.equal(rec.voice_id, '21m00Tcm4TlvDq8ikWAM');
    assert.equal(rec.voice_name, 'Rachel');
  });

  it('auto-versioning: pre-existing halt.mp3 → writes halt-v2.mp3', async () => {
    const existingDir = path.join(tmp, 'assets', 'audio', 'voice');
    fs.mkdirSync(existingDir, { recursive: true });
    fs.writeFileSync(path.join(existingDir, 'halt.mp3'), 'preexisting');

    const parsed = parseArgs([
      'voice',
      'Halt!',
      '--voice-id',
      'JBFqnCBsd6RMkjVDRZzb',
    ]);
    const bytes = Buffer.from('NEW');
    const fetchImpl = fetchScript([makeResponse({ bodyBytes: bytes })]);
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();

    const r = await runCatching(() => runTTS(parsed, { fetchImpl, stdout, stderr }));
    assert.equal(r.exitCode, null, r.stderr);
    assert.equal(
      fs.readFileSync(path.join(existingDir, 'halt.mp3'), 'utf8'),
      'preexisting'
    );
    const v2 = path.join(existingDir, 'halt-v2.mp3');
    assert.ok(fs.existsSync(v2));
    assert.deepEqual(fs.readFileSync(v2), bytes);
  });

  it('shadow warning emitted to stderr when input shadows cache name', async () => {
    const cachedId = 'realidAAAAAAAAAAAAAA';
    const shadowName = 'abcdefghij1234567890';
    writeCache(tmp, [{ voice_id: cachedId, name: shadowName }]);

    const parsed = parseArgs(['voice', 'hi', '--voice-id', shadowName]);
    const bytes = Buffer.from('OK');
    const fetchImpl = fetchScript([makeResponse({ bodyBytes: bytes })]);
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();

    const r = await runCatching(() => runTTS(parsed, { fetchImpl, stdout, stderr }));
    assert.equal(r.exitCode, null, r.stderr);
    assert.ok(
      stderr.buf.includes('voice-id pattern') || stderr.buf.includes('cached voice name'),
      `stderr=${stderr.buf}`
    );
    // URL used the cached id, not the shadow name.
    assert.ok(fetchImpl.calls[0].url.includes(`/v1/text-to-speech/${cachedId}?`));
  });
});

// ── CLI integration ────────────────────────────────────────────────

describe('voice CLI integration', () => {
  it('AC1: voice "Halt!" --voice-id ... --dry-run prints exact URL + body', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-voice-cli-'));
    try {
      const out = execFileSync(
        process.execPath,
        [gen, 'voice', 'Halt!', '--voice-id', 'JBFqnCBsd6RMkjVDRZzb', '--dry-run'],
        { encoding: 'utf8', timeout: 5000, cwd: tmp }
      );
      assert.ok(
        out.includes(
          'url: https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=mp3_44100_128'
        ),
        `out=${out}`
      );
      assert.ok(
        out.includes('body: {"text":"Halt!","model_id":"eleven_multilingual_v2"}'),
        `out=${out}`
      );
      // No history or assets created on dry-run.
      assert.ok(!fs.existsSync(path.join(tmp, 'assets')));
      assert.ok(!fs.existsSync(path.join(tmp, '.audiogen-history.jsonl')));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('AC2: fixture cache with "Rachel" resolves --voice-id Rachel', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-voice-cli-'));
    try {
      fs.writeFileSync(
        path.join(tmp, '.audiogen-voices.json'),
        JSON.stringify({
          fetched_at: new Date().toISOString(),
          voices: [{ voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel' }],
        })
      );
      const out = execFileSync(
        process.execPath,
        [gen, 'voice', 'hi', '--voice-id', 'Rachel', '--dry-run'],
        { encoding: 'utf8', timeout: 5000, cwd: tmp }
      );
      assert.ok(
        out.includes('/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM?'),
        `out=${out}`
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('AC3: duplicate "Adam" names → disambiguation error', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-voice-cli-'));
    try {
      fs.writeFileSync(
        path.join(tmp, '.audiogen-voices.json'),
        JSON.stringify({
          fetched_at: new Date().toISOString(),
          voices: [
            { voice_id: 'AAAAAAAAAAAAAAAAAAAA', name: 'Adam', category: 'premade' },
            { voice_id: 'BBBBBBBBBBBBBBBBBBBB', name: 'Adam', category: 'cloned' },
          ],
        })
      );
      assert.throws(
        () =>
          execFileSync(
            process.execPath,
            [gen, 'voice', 'hi', '--voice-id', 'Adam', '--dry-run'],
            { encoding: 'utf8', timeout: 5000, cwd: tmp }
          ),
        (e) => {
          assert.equal(e.status, 1);
          assert.ok(e.stderr.includes('AAAAAAAAAAAAAAAAAAAA'), e.stderr);
          assert.ok(e.stderr.includes('BBBBBBBBBBBBBBBBBBBB'), e.stderr);
          return true;
        }
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('text > 40000 chars exits 1 with clear message', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-voice-cli-'));
    try {
      const big = 'a'.repeat(VOICE_TEXT_MAX_LEN + 1);
      assert.throws(
        () =>
          execFileSync(
            process.execPath,
            [gen, 'voice', big, '--voice-id', 'JBFqnCBsd6RMkjVDRZzb', '--dry-run'],
            { encoding: 'utf8', timeout: 5000, cwd: tmp }
          ),
        (e) => {
          assert.equal(e.status, 1);
          assert.ok(e.stderr.includes(`max is ${VOICE_TEXT_MAX_LEN}`), e.stderr);
          return true;
        }
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('missing --voice-id with no cache exits 1 with require-voice-id message', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-voice-cli-'));
    try {
      assert.throws(
        () =>
          execFileSync(
            process.execPath,
            [gen, 'voice', 'hello', '--dry-run'],
            { encoding: 'utf8', timeout: 5000, cwd: tmp }
          ),
        (e) => {
          assert.equal(e.status, 1);
          assert.ok(/Voice generation requires --voice-id/.test(e.stderr), e.stderr);
          return true;
        }
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
