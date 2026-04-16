// tests/voices.test.js — Phase 3 voices catalog subcommand:
//   - pagination walker over v2/voices
//   - include_total_count=false in URL query
//   - atomic cache write (tmp → rename, no .tmp left behind)
//   - corrupt cache → silent refetch + overwrite
//   - TTL: fresh cache → no fetch; stale cache → refetch; --refresh bypasses fresh
//   - client-side filtering: query, language, gender, accent, category combos
//   - --limit N caps output count
//   - --json emits parseable JSON matching the filter
//   - --dry-run never fetches, never touches cache file
//
// Uses callElevenLabs({ responseType: 'json' }) under the hood (verified
// indirectly by the success of JSON round-tripping through fetch stubs).
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const gen = path.resolve(__dirname, '..', '.claude', 'skills', 'audiogen', 'generate.cjs');
const {
  runVoicesList,
  fetchAllVoices,
  readVoicesCache,
  writeVoicesCache,
  filterVoices,
  parseArgs,
  VOICES_CACHE_FILENAME,
  VOICES_CACHE_TMP_FILENAME,
  VOICES_CACHE_TTL_MS,
} = require(gen);

// ── Helpers ────────────────────────────────────────────────────────

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

function makeJsonResponse(obj, { status = 200, headers = {} } = {}) {
  const text = JSON.stringify(obj);
  const hdrs = new Map();
  hdrs.set('content-type', 'application/json');
  for (const [k, v] of Object.entries(headers)) hdrs.set(k.toLowerCase(), String(v));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : '',
    headers: { get: (k) => hdrs.get(String(k).toLowerCase()) || null },
    body: null, // callElevenLabs uses .text() for JSON
    text: async () => text,
  };
}

function fetchScript(responses) {
  const calls = [];
  let i = 0;
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (i >= responses.length) {
      throw new Error(`fetch called more times than scripted (call #${i + 1}): ${url}`);
    }
    const r = responses[i++];
    if (r instanceof Error) throw r;
    return r;
  };
  impl.calls = calls;
  return impl;
}

function fixtureVoice({
  voice_id,
  name,
  category = 'premade',
  labels = {},
  preview_url,
  ...rest
} = {}) {
  return {
    voice_id,
    name,
    category,
    labels,
    ...(preview_url ? { preview_url } : {}),
    ...rest,
  };
}

// ── fetchAllVoices (pagination) ────────────────────────────────────

describe('fetchAllVoices pagination', () => {
  let origKey;
  beforeEach(() => {
    origKey = process.env.ELEVENLABS_API_KEY;
    process.env.ELEVENLABS_API_KEY = 'test-key';
  });
  afterEach(() => {
    if (origKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = origKey;
  });

  it('stub 3 pages → concatenates all voices, stops on has_more:false', async () => {
    const fetchImpl = fetchScript([
      makeJsonResponse({
        voices: [fixtureVoice({ voice_id: 'id1', name: 'A' })],
        has_more: true,
        next_page_token: 'tok2',
      }),
      makeJsonResponse({
        voices: [fixtureVoice({ voice_id: 'id2', name: 'B' })],
        has_more: true,
        next_page_token: 'tok3',
      }),
      makeJsonResponse({
        voices: [fixtureVoice({ voice_id: 'id3', name: 'C' })],
        has_more: false,
      }),
    ]);

    const voices = await fetchAllVoices({ fetchImpl });
    assert.equal(voices.length, 3);
    assert.deepEqual(
      voices.map((v) => v.voice_id),
      ['id1', 'id2', 'id3']
    );
    assert.equal(fetchImpl.calls.length, 3);

    // Every request must include include_total_count=false + page_size.
    for (const c of fetchImpl.calls) {
      assert.ok(c.url.includes('include_total_count=false'), c.url);
      assert.ok(c.url.includes('page_size='), c.url);
    }
    // First call: no next_page_token; subsequent: token threaded through.
    assert.ok(!fetchImpl.calls[0].url.includes('next_page_token='));
    assert.ok(fetchImpl.calls[1].url.includes('next_page_token=tok2'));
    assert.ok(fetchImpl.calls[2].url.includes('next_page_token=tok3'));
  });

  it('single page (has_more:false on page 1) → one fetch call', async () => {
    const fetchImpl = fetchScript([
      makeJsonResponse({
        voices: [fixtureVoice({ voice_id: 'x', name: 'X' })],
        has_more: false,
      }),
    ]);
    const voices = await fetchAllVoices({ fetchImpl });
    assert.equal(voices.length, 1);
    assert.equal(fetchImpl.calls.length, 1);
  });

  it('custom pageSize reflected in URL', async () => {
    const fetchImpl = fetchScript([
      makeJsonResponse({ voices: [], has_more: false }),
    ]);
    await fetchAllVoices({ fetchImpl, pageSize: 25 });
    assert.ok(fetchImpl.calls[0].url.includes('page_size=25'), fetchImpl.calls[0].url);
  });
});

// ── readVoicesCache / writeVoicesCache (atomic) ────────────────────

describe('writeVoicesCache atomic', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-voices-cache-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writes via .tmp then renames; no .tmp left behind', () => {
    const cache = path.join(tmp, VOICES_CACHE_FILENAME);
    const voices = [fixtureVoice({ voice_id: 'id1', name: 'A' })];
    writeVoicesCache(cache, voices);
    assert.ok(fs.existsSync(cache));
    assert.ok(!fs.existsSync(path.join(tmp, VOICES_CACHE_TMP_FILENAME)));

    const raw = fs.readFileSync(cache, 'utf8');
    const obj = JSON.parse(raw);
    assert.ok(typeof obj.fetched_at === 'string');
    assert.deepEqual(obj.voices, voices);
  });

  it('overwrites an existing cache atomically (rename replaces)', () => {
    const cache = path.join(tmp, VOICES_CACHE_FILENAME);
    writeVoicesCache(cache, [fixtureVoice({ voice_id: 'old', name: 'OLD' })]);
    writeVoicesCache(cache, [fixtureVoice({ voice_id: 'new', name: 'NEW' })]);
    const obj = JSON.parse(fs.readFileSync(cache, 'utf8'));
    assert.equal(obj.voices[0].voice_id, 'new');
    assert.ok(!fs.existsSync(path.join(tmp, VOICES_CACHE_TMP_FILENAME)));
  });
});

describe('readVoicesCache parse handling', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-voices-read-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('missing file → null', () => {
    const cache = path.join(tmp, VOICES_CACHE_FILENAME);
    assert.equal(readVoicesCache(cache), null);
  });

  it('corrupt JSON → calls onParseError and returns null', () => {
    const cache = path.join(tmp, VOICES_CACHE_FILENAME);
    fs.writeFileSync(cache, '{not valid');
    let called = null;
    const out = readVoicesCache(cache, { onParseError: (p) => (called = p) });
    assert.equal(out, null);
    assert.equal(called, cache);
  });

  it('shape without voices array → null', () => {
    const cache = path.join(tmp, VOICES_CACHE_FILENAME);
    fs.writeFileSync(cache, JSON.stringify({ fetched_at: 'x' }));
    assert.equal(readVoicesCache(cache), null);
  });
});

// ── filterVoices ───────────────────────────────────────────────────

describe('filterVoices', () => {
  const catalog = [
    fixtureVoice({
      voice_id: 'id_rachel',
      name: 'Rachel',
      labels: { accent: 'American', gender: 'female', language: 'en' },
    }),
    fixtureVoice({
      voice_id: 'id_adam',
      name: 'Adam',
      labels: { accent: 'British', gender: 'male', language: 'en' },
    }),
    fixtureVoice({
      voice_id: 'id_taro',
      name: 'Taro',
      labels: { accent: 'Japanese', gender: 'male', language: 'ja' },
    }),
    fixtureVoice({ voice_id: 'id_x', name: 'Unlabeled' }),
  ];

  it('empty filter → all voices returned', () => {
    assert.equal(filterVoices(catalog, {}).length, 4);
  });

  it('query matches name substring (case-insensitive)', () => {
    const r = filterVoices(catalog, { query: 'rach' });
    assert.equal(r.length, 1);
    assert.equal(r[0].voice_id, 'id_rachel');
  });

  it('query matches any string label value', () => {
    const r = filterVoices(catalog, { query: 'british' });
    assert.equal(r.length, 1);
    assert.equal(r[0].voice_id, 'id_adam');
  });

  it('gender is exact-lower match', () => {
    const r = filterVoices(catalog, { gender: 'male' });
    assert.equal(r.length, 2);
    assert.ok(r.every((v) => v.labels.gender === 'male'));
  });

  it('accent is substring match', () => {
    const r = filterVoices(catalog, { accent: 'american' });
    assert.equal(r.length, 1);
    assert.equal(r[0].voice_id, 'id_rachel');
  });

  it('category is exact match', () => {
    const r = filterVoices(catalog, { category: 'premade' });
    assert.equal(r.length, 4);
    assert.equal(filterVoices(catalog, { category: 'cloned' }).length, 0);
  });

  it('language matches labels.language substring', () => {
    assert.equal(filterVoices(catalog, { language: 'ja' }).length, 1);
    assert.equal(filterVoices(catalog, { language: 'en' }).length, 2);
  });

  it('language also checks fine_tuning.language + verified_languages', () => {
    const extra = [
      fixtureVoice({
        voice_id: 'id_ft',
        name: 'FT',
        fine_tuning: { language: 'de' },
      }),
      fixtureVoice({
        voice_id: 'id_vl',
        name: 'VL',
        verified_languages: [{ language: 'fr' }],
      }),
    ];
    const r1 = filterVoices(extra, { language: 'de' });
    assert.equal(r1.length, 1);
    assert.equal(r1[0].voice_id, 'id_ft');
    const r2 = filterVoices(extra, { language: 'fr' });
    assert.equal(r2.length, 1);
    assert.equal(r2[0].voice_id, 'id_vl');
  });

  it('combinators: query + gender + accent', () => {
    // "en" hits Rachel + Adam via language label; gender male narrows to Adam;
    // accent British keeps Adam only.
    const r = filterVoices(catalog, {
      query: 'en',
      gender: 'male',
      accent: 'british',
    });
    assert.equal(r.length, 1);
    assert.equal(r[0].voice_id, 'id_adam');
  });

  it('missing label field tolerated — filter simply excludes that voice', () => {
    const r = filterVoices(catalog, { gender: 'female' });
    assert.equal(r.length, 1);
    assert.equal(r[0].voice_id, 'id_rachel');
    // Unlabeled voice is excluded from gender filter but included on no-filter.
    assert.equal(filterVoices(catalog, {}).find((v) => v.voice_id === 'id_x').voice_id, 'id_x');
  });
});

// ── runVoicesList ──────────────────────────────────────────────────

describe('runVoicesList dry-run', () => {
  let tmp, origCwd, origKey;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-voices-dry-'));
    origCwd = process.cwd();
    origKey = process.env.ELEVENLABS_API_KEY;
    // Intentionally do NOT set API key to prove dry-run never needs it.
    delete process.env.ELEVENLABS_API_KEY;
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(origCwd);
    if (origKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = origKey;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('dry-run does not fetch and does not touch cache file', async () => {
    const parsed = parseArgs(['voices', '--dry-run']);
    const fetchImpl = fetchScript([]); // will throw on any call
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const cachePath = path.join(tmp, '.audiogen-voices.json');

    // Cache does not exist before run
    assert.ok(!fs.existsSync(cachePath));

    const r = await runCatching(() =>
      runVoicesList(parsed, { fetchImpl, stdout, stderr, cachePath })
    );
    assert.equal(r.exitCode, null, `stderr=${r.stderr}`);
    assert.equal(fetchImpl.calls.length, 0);
    assert.ok(!fs.existsSync(cachePath));
    assert.ok(!fs.existsSync(path.join(tmp, '.audiogen-voices.json.tmp')));
    assert.ok(stdout.buf.includes('audiogen dry-run (voices)'), stdout.buf);
    assert.ok(
      stdout.buf.includes('url: https://api.elevenlabs.io/v2/voices?'),
      stdout.buf
    );
    assert.ok(stdout.buf.includes('include_total_count=false'), stdout.buf);
  });

  it('dry-run with existing cache does not mutate mtime', async () => {
    const cachePath = path.join(tmp, '.audiogen-voices.json');
    fs.writeFileSync(
      cachePath,
      JSON.stringify({ fetched_at: 'pre', voices: [] })
    );
    const before = fs.statSync(cachePath).mtimeMs;

    // Small wait to ensure mtime resolution isn't a factor.
    await new Promise((r) => setTimeout(r, 10));
    const parsed = parseArgs(['voices', '--dry-run']);
    const fetchImpl = fetchScript([]);
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const r = await runCatching(() =>
      runVoicesList(parsed, { fetchImpl, stdout, stderr, cachePath })
    );
    assert.equal(r.exitCode, null, r.stderr);
    const after = fs.statSync(cachePath).mtimeMs;
    assert.equal(before, after, 'cache mtime should be unchanged on dry-run');
  });
});

describe('runVoicesList live (stubbed fetch)', () => {
  let tmp, origCwd, origKey;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-voices-live-'));
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

  it('no cache → 3-page paginated fetch → cache contains union of pages', async () => {
    const parsed = parseArgs(['voices']);
    const cachePath = path.join(tmp, VOICES_CACHE_FILENAME);
    const fetchImpl = fetchScript([
      makeJsonResponse({
        voices: [fixtureVoice({ voice_id: 'p1a', name: 'Alpha' })],
        has_more: true,
        next_page_token: 't2',
      }),
      makeJsonResponse({
        voices: [fixtureVoice({ voice_id: 'p2a', name: 'Beta' })],
        has_more: true,
        next_page_token: 't3',
      }),
      makeJsonResponse({
        voices: [fixtureVoice({ voice_id: 'p3a', name: 'Gamma' })],
        has_more: false,
      }),
    ]);
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();

    const r = await runCatching(() =>
      runVoicesList(parsed, { fetchImpl, stdout, stderr, cachePath })
    );
    assert.equal(r.exitCode, null, r.stderr);
    assert.equal(fetchImpl.calls.length, 3);

    assert.ok(fs.existsSync(cachePath));
    const obj = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    assert.equal(obj.voices.length, 3);
    assert.deepEqual(
      obj.voices.map((v) => v.voice_id),
      ['p1a', 'p2a', 'p3a']
    );
    // No .tmp left behind.
    assert.ok(!fs.existsSync(path.join(tmp, VOICES_CACHE_TMP_FILENAME)));

    // Table output should include the voice names.
    assert.ok(stdout.buf.includes('Alpha'), stdout.buf);
    assert.ok(stdout.buf.includes('Beta'), stdout.buf);
    assert.ok(stdout.buf.includes('Gamma'), stdout.buf);
  });

  it('fresh cache hit → no fetch', async () => {
    const cachePath = path.join(tmp, VOICES_CACHE_FILENAME);
    writeVoicesCache(cachePath, [
      fixtureVoice({ voice_id: 'cached1', name: 'Cached' }),
    ]);
    const parsed = parseArgs(['voices']);
    const fetchImpl = fetchScript([]); // must not be called
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();

    const r = await runCatching(() =>
      runVoicesList(parsed, { fetchImpl, stdout, stderr, cachePath })
    );
    assert.equal(r.exitCode, null, r.stderr);
    assert.equal(fetchImpl.calls.length, 0);
    assert.ok(stdout.buf.includes('Cached'), stdout.buf);
  });

  it('stale cache (>24h) triggers refetch', async () => {
    const cachePath = path.join(tmp, VOICES_CACHE_FILENAME);
    writeVoicesCache(cachePath, [fixtureVoice({ voice_id: 'old', name: 'Old' })]);
    // Backdate the mtime by 25h.
    const ageMs = VOICES_CACHE_TTL_MS + 60 * 60 * 1000;
    const newTime = new Date(Date.now() - ageMs);
    fs.utimesSync(cachePath, newTime, newTime);

    const parsed = parseArgs(['voices']);
    const fetchImpl = fetchScript([
      makeJsonResponse({
        voices: [fixtureVoice({ voice_id: 'fresh', name: 'Fresh' })],
        has_more: false,
      }),
    ]);
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();

    const r = await runCatching(() =>
      runVoicesList(parsed, { fetchImpl, stdout, stderr, cachePath })
    );
    assert.equal(r.exitCode, null, r.stderr);
    assert.equal(fetchImpl.calls.length, 1);
    const obj = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    assert.equal(obj.voices.length, 1);
    assert.equal(obj.voices[0].voice_id, 'fresh');
  });

  it('--refresh bypasses fresh cache', async () => {
    const cachePath = path.join(tmp, VOICES_CACHE_FILENAME);
    writeVoicesCache(cachePath, [fixtureVoice({ voice_id: 'old', name: 'Old' })]);
    const parsed = parseArgs(['voices', '--refresh']);
    const fetchImpl = fetchScript([
      makeJsonResponse({
        voices: [fixtureVoice({ voice_id: 'fresh', name: 'Fresh' })],
        has_more: false,
      }),
    ]);
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();

    const r = await runCatching(() =>
      runVoicesList(parsed, { fetchImpl, stdout, stderr, cachePath })
    );
    assert.equal(r.exitCode, null, r.stderr);
    assert.equal(fetchImpl.calls.length, 1);
  });

  it('corrupt cache → silent refetch + overwrite + stderr warning', async () => {
    const cachePath = path.join(tmp, VOICES_CACHE_FILENAME);
    fs.writeFileSync(cachePath, '{not valid json');
    const parsed = parseArgs(['voices']);
    const fetchImpl = fetchScript([
      makeJsonResponse({
        voices: [fixtureVoice({ voice_id: 'fresh', name: 'Fresh' })],
        has_more: false,
      }),
    ]);
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();

    const r = await runCatching(() =>
      runVoicesList(parsed, { fetchImpl, stdout, stderr, cachePath })
    );
    assert.equal(r.exitCode, null, r.stderr);
    assert.equal(fetchImpl.calls.length, 1);
    assert.ok(
      stderr.buf.includes('cache parse error') || stderr.buf.includes('parse'),
      `stderr=${stderr.buf}`
    );
    const obj = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    assert.equal(obj.voices[0].voice_id, 'fresh');
  });

  it('atomic: no .tmp file left behind after successful fetch', async () => {
    const cachePath = path.join(tmp, VOICES_CACHE_FILENAME);
    const parsed = parseArgs(['voices']);
    const fetchImpl = fetchScript([
      makeJsonResponse({
        voices: [fixtureVoice({ voice_id: 'a', name: 'A' })],
        has_more: false,
      }),
    ]);
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const r = await runCatching(() =>
      runVoicesList(parsed, { fetchImpl, stdout, stderr, cachePath })
    );
    assert.equal(r.exitCode, null, r.stderr);
    assert.ok(!fs.existsSync(path.join(tmp, VOICES_CACHE_TMP_FILENAME)));
  });

  it('query + filters applied client-side after pagination', async () => {
    const cachePath = path.join(tmp, VOICES_CACHE_FILENAME);
    const parsed = parseArgs([
      'voices',
      'brit',
      '--gender',
      'male',
    ]);
    const fetchImpl = fetchScript([
      makeJsonResponse({
        voices: [
          fixtureVoice({
            voice_id: 'id1',
            name: 'Brit Guy',
            labels: { gender: 'male', accent: 'British' },
          }),
          fixtureVoice({
            voice_id: 'id2',
            name: 'Brit Girl',
            labels: { gender: 'female', accent: 'British' },
          }),
          fixtureVoice({
            voice_id: 'id3',
            name: 'American',
            labels: { gender: 'male', accent: 'American' },
          }),
        ],
        has_more: false,
      }),
    ]);
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const r = await runCatching(() =>
      runVoicesList(parsed, { fetchImpl, stdout, stderr, cachePath })
    );
    assert.equal(r.exitCode, null, r.stderr);
    assert.ok(stdout.buf.includes('Brit Guy'), stdout.buf);
    assert.ok(!stdout.buf.includes('Brit Girl'), stdout.buf);
    assert.ok(!stdout.buf.includes('American'), stdout.buf);
  });

  it('--json emits parseable JSON of the filtered list', async () => {
    const cachePath = path.join(tmp, VOICES_CACHE_FILENAME);
    writeVoicesCache(cachePath, [
      fixtureVoice({ voice_id: 'id1', name: 'Rachel', labels: { gender: 'female' } }),
      fixtureVoice({ voice_id: 'id2', name: 'Adam', labels: { gender: 'male' } }),
    ]);
    const parsed = parseArgs(['voices', '--json', '--gender', 'female']);
    const fetchImpl = fetchScript([]); // fresh cache, no fetch
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const r = await runCatching(() =>
      runVoicesList(parsed, { fetchImpl, stdout, stderr, cachePath })
    );
    assert.equal(r.exitCode, null, r.stderr);
    const parsedOut = JSON.parse(stdout.buf.trim());
    assert.ok(Array.isArray(parsedOut));
    assert.equal(parsedOut.length, 1);
    assert.equal(parsedOut[0].voice_id, 'id1');
  });

  it('--limit N caps table output rows', async () => {
    const cachePath = path.join(tmp, VOICES_CACHE_FILENAME);
    const big = [];
    for (let i = 0; i < 30; i++) {
      big.push(fixtureVoice({
        voice_id: `id${i.toString().padStart(2, '0')}`,
        name: `V${i.toString().padStart(2, '0')}`,
      }));
    }
    writeVoicesCache(cachePath, big);
    const parsed = parseArgs(['voices', '--limit', '5']);
    const fetchImpl = fetchScript([]);
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const r = await runCatching(() =>
      runVoicesList(parsed, { fetchImpl, stdout, stderr, cachePath })
    );
    assert.equal(r.exitCode, null, r.stderr);

    // Expect 1 header row + 5 data rows + 1 overflow row.
    const rows = stdout.buf.trimEnd().split('\n');
    const dataRows = rows.filter((l) => /^V\d\d/.test(l.trim()));
    assert.equal(dataRows.length, 5, `rows:\n${stdout.buf}`);
    assert.ok(
      rows.some((l) => /^\(\+25 more/.test(l)),
      stdout.buf
    );
  });

  it('uses responseType json (first fetch URL is /v2/voices)', async () => {
    const cachePath = path.join(tmp, VOICES_CACHE_FILENAME);
    const parsed = parseArgs(['voices']);
    const fetchImpl = fetchScript([
      makeJsonResponse({ voices: [], has_more: false }),
    ]);
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const r = await runCatching(() =>
      runVoicesList(parsed, { fetchImpl, stdout, stderr, cachePath })
    );
    assert.equal(r.exitCode, null, r.stderr);
    assert.equal(fetchImpl.calls.length, 1);
    const call = fetchImpl.calls[0];
    assert.ok(call.url.startsWith('https://api.elevenlabs.io/v2/voices?'), call.url);
    assert.equal(call.init.method, 'GET');
    // No body on GET
    assert.equal(call.init.body, undefined);
    // Auth header present.
    assert.equal(call.init.headers['xi-api-key'], 'test-key');
  });
});

// ── CLI integration ───────────────────────────────────────────────

describe('voices CLI integration', () => {
  it('AC4: --dry-run without cache does not fetch and does not touch cache', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-voices-cli-'));
    try {
      const cachePath = path.join(tmp, '.audiogen-voices.json');
      assert.ok(!fs.existsSync(cachePath));
      const out = execFileSync(
        process.execPath,
        [gen, 'voices', '--dry-run'],
        { encoding: 'utf8', timeout: 5000, cwd: tmp }
      );
      assert.ok(out.includes('audiogen dry-run (voices)'), out);
      assert.ok(out.includes('include_total_count=false'), out);
      assert.ok(!fs.existsSync(cachePath));
      assert.ok(!fs.existsSync(path.join(tmp, '.audiogen-voices.json.tmp')));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('--dry-run with pre-existing cache does not change its mtime', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-voices-cli-'));
    try {
      const cachePath = path.join(tmp, '.audiogen-voices.json');
      fs.writeFileSync(
        cachePath,
        JSON.stringify({ fetched_at: 'x', voices: [] })
      );
      const mtimeBefore = fs.statSync(cachePath).mtimeMs;
      execFileSync(
        process.execPath,
        [gen, 'voices', '--dry-run'],
        { encoding: 'utf8', timeout: 5000, cwd: tmp }
      );
      const mtimeAfter = fs.statSync(cachePath).mtimeMs;
      assert.equal(mtimeBefore, mtimeAfter);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
