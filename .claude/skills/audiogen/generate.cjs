#!/usr/bin/env node
// audiogen — generate game audio (music, voices, sound effects) via ElevenLabs.
//
// Phase 1: scaffold + shared core. Endpoint logic (runMusic / runTTS / runSFX
// / runVoicesList) is filled in phases 2-4; each currently throws
// "not yet implemented" when reached.
//
// Zero npm deps. Node >= 20.14 required (for process.loadEnvFile).

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

// ────────────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────────────

/**
 * Print an error to stderr in the audiogen format and exit 1.
 * Structured details are indented under the summary line.
 *
 * @param {string} msg  One-line summary.
 * @param {object} [details]  Optional key/value lines to print below.
 */
function fail(msg, details) {
  process.stderr.write(`audiogen: ${msg}\n`);
  if (details && typeof details === 'object') {
    for (const [k, v] of Object.entries(details)) {
      if (v === undefined || v === null || v === '') continue;
      process.stderr.write(`  ${k}: ${v}\n`);
    }
  }
  process.exit(1);
}

// ────────────────────────────────────────────────────────────────────
// Env loader
// ────────────────────────────────────────────────────────────────────

/**
 * Locate and load a `.env` file. Mirrors imagegen's env walker verbatim.
 *
 * Candidate list:
 *   1. process.cwd()  (single candidate, NO walk-up from cwd)
 *   2. Every ancestor of __dirname, from __dirname itself up to '/'.
 *
 * Duplicates (cwd may equal an ancestor of __dirname) are deduped.
 * For each candidate `d`, if `<d>/.env` exists, call `process.loadEnvFile`
 * on it in try/catch and return on success (stop walking).
 *
 * Overwrite semantics: Node's `process.loadEnvFile` gives SHELL-EXPORTED
 * values precedence over file values. `ELEVENLABS_API_KEY=X` in the shell
 * overrides `ELEVENLABS_API_KEY=Y` in `.env`. This is Node's default; we
 * do NOT invert it.
 *
 * Node floor: requires Node >= 20.14 (process.loadEnvFile availability).
 * Callers should assert this before invoking loadEnv.
 */
function loadEnv() {
  if (typeof process.loadEnvFile !== 'function') return;

  const candidates = [process.cwd()];
  let d = path.dirname(__filename);
  while (true) {
    candidates.push(d);
    const parent = path.dirname(d);
    if (parent === d) break; // hit filesystem root
    d = parent;
  }
  const seen = new Set();
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    const envPath = path.join(c, '.env');
    if (!fs.existsSync(envPath)) continue;
    try {
      process.loadEnvFile(envPath);
      return;
    } catch (_e) {
      // try next candidate; .env may be malformed or unreadable
    }
  }
}

function assertNodeVersion() {
  if (typeof process.loadEnvFile !== 'function') {
    fail(
      `Node.js >= 20.14 required (process.loadEnvFile unavailable on ${process.version})`
    );
  }
}

function assertApiKey() {
  const k = process.env.ELEVENLABS_API_KEY;
  if (!k) {
    fail(
      'ELEVENLABS_API_KEY is not set. Create one at https://elevenlabs.io/app/settings/api-keys and export it, or add it to a .env file in the project root.'
    );
  }
  return k;
}

// ────────────────────────────────────────────────────────────────────
// Slugify + output path
// ────────────────────────────────────────────────────────────────────

function timestampSlug(tz) {
  // YYYYMMDD-HHMMSS in the given IANA timezone (default America/New_York).
  const d = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz || 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  let hh = get('hour');
  if (hh === '24') hh = '00'; // hour12:false can yield 24
  return `audio-${get('year')}${get('month')}${get('day')}-${hh}${get('minute')}${get('second')}`;
}

/**
 * slugify(prompt): first 40 chars → lowercase → collapse non-alphanumeric
 * to `-` → trim leading/trailing `-`. Empty result (common for non-Latin
 * prompts) falls back to `audio-<YYYYMMDD-HHMMSS>`.
 *
 * @param {string} prompt
 * @param {string} [tz]  IANA timezone for empty-slug fallback.
 */
function slugify(prompt, tz) {
  const head = (prompt || '').slice(0, 40).toLowerCase();
  const s = head.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length === 0) return timestampSlug(tz);
  return s;
}

function extFromOutputFormat(fmt) {
  if (!fmt || typeof fmt !== 'string') return 'bin';
  if (fmt.startsWith('mp3_')) return 'mp3';
  if (fmt.startsWith('pcm_') || fmt.startsWith('wav_')) return 'wav';
  if (fmt.startsWith('opus_')) return 'opus';
  if (fmt.startsWith('ulaw_') || fmt.startsWith('alaw_')) return 'raw';
  return 'bin';
}

/**
 * resolveOutputPath — picks where to write the generated file.
 *
 * - If `outputOption` is set and names an existing directory (or ends in `/`):
 *       base = <outputOption>/<slug>.<ext>
 * - If `outputOption` is set and is not a directory:
 *       base = <outputOption> verbatim (extension honored as given).
 * - Otherwise:
 *       base = assets/audio/<type>/<slug>.<ext>
 *
 * If `base` does not exist OR `force` is true, return base. Otherwise
 * auto-bump through <prefix>-v2.<ext> … <prefix>-v999.<ext> and return
 * the first non-existent path. If all 999 are taken, fail().
 *
 * @param {object} opts
 * @param {string} opts.type  music | voice | sfx | voices
 * @param {string} opts.prompt
 * @param {string} [opts.outputOption]
 * @param {string} opts.outputFormat
 * @param {boolean} [opts.force]
 * @param {string} [opts.tz]
 */
function resolveOutputPath({ type, prompt, outputOption, outputFormat, force, tz }) {
  const ext = extFromOutputFormat(outputFormat);
  const slug = slugify(prompt, tz);

  let base;
  if (outputOption) {
    const looksLikeDir =
      outputOption.endsWith('/') ||
      (fs.existsSync(outputOption) && fs.statSync(outputOption).isDirectory());
    if (looksLikeDir) {
      base = path.join(outputOption.replace(/\/+$/, ''), `${slug}.${ext}`);
    } else {
      base = outputOption;
    }
  } else {
    base = path.join('assets', 'audio', type, `${slug}.${ext}`);
  }

  if (force || !fs.existsSync(base)) return base;

  // Auto-version: split extension off of `base`.
  const dir = path.dirname(base);
  const baseName = path.basename(base);
  const dot = baseName.lastIndexOf('.');
  const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
  const extOnFile = dot > 0 ? baseName.slice(dot) : '';

  for (let v = 2; v <= 999; v++) {
    const cand = path.join(dir, `${stem}-v${v}${extOnFile}`);
    if (!fs.existsSync(cand)) return cand;
  }
  fail(
    `too many versions for ${base} — clean up ${dir}/ or pass --output explicitly.`
  );
}

function mkdirpParent(outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
}

// ────────────────────────────────────────────────────────────────────
// History
// ────────────────────────────────────────────────────────────────────

/**
 * Append one JSON line to `${cwd}/.audiogen-history.jsonl`.
 *
 * On failure, emits a stderr warning and returns. Never throws — history
 * is best-effort and must not abort the generation.
 *
 * @param {object} record
 * @param {(path: string, data: string) => void} [writeFn]  Injectable for tests.
 */
function appendHistory(record, writeFn = fs.appendFileSync) {
  const line = JSON.stringify(record) + '\n';
  const target = path.join(process.cwd(), '.audiogen-history.jsonl');
  try {
    writeFn(target, line);
  } catch (e) {
    process.stderr.write(
      `audiogen: warning — failed to append history (${e && e.message ? e.message : e}); continuing.\n`
    );
  }
}

// ────────────────────────────────────────────────────────────────────
// CLI arg parser
// ────────────────────────────────────────────────────────────────────

const SUBCOMMANDS = new Set(['music', 'voice', 'sfx', 'voices']);

// Flag registry. For each flag: { value: true } means it consumes the next
// token; { value: false } is boolean (no value).
const FLAG_SPECS = {
  // Common
  '--output': { value: true, key: 'output' },
  '--output-format': { value: true, key: 'outputFormat' },
  '--seed': { value: true, key: 'seed' },
  '--model-id': { value: true, key: 'modelId' },
  '--dry-run': { value: false, key: 'dryRun' },
  '--force': { value: false, key: 'force' },
  '--history-id': { value: true, key: 'historyId' },
  '--history-parent': { value: true, key: 'historyParent' },
  '--help': { value: false, key: 'help' },
  // Music
  '--length-ms': { value: true, key: 'lengthMs' },
  '--force-instrumental': { value: false, key: 'forceInstrumental' },
  // Voice
  '--voice-id': { value: true, key: 'voiceId' },
  '--language-code': { value: true, key: 'languageCode' },
  '--stability': { value: true, key: 'stability' },
  '--similarity-boost': { value: true, key: 'similarityBoost' },
  '--style': { value: true, key: 'style' },
  '--speed': { value: true, key: 'speed' },
  // SFX
  '--duration': { value: true, key: 'duration' },
  '--loop': { value: false, key: 'loop' },
  '--prompt-influence': { value: true, key: 'promptInfluence' },
  // Voices
  '--language': { value: true, key: 'language' },
  '--gender': { value: true, key: 'gender' },
  '--accent': { value: true, key: 'accent' },
  '--category': { value: true, key: 'category' },
  '--json': { value: false, key: 'json' },
  '--refresh': { value: false, key: 'refresh' },
  '--page-size': { value: true, key: 'pageSize' },
};

/**
 * Parse argv (already sliced past `node generate.cjs`).
 *
 * Throws {message, exitCode} for usage errors so callers may print usage.
 * Does not read env or touch disk.
 *
 * Result shape:
 *   { subcommand, positionals: [...], flags: {...}, help: bool }
 *
 * If `--help` appears anywhere, returns { help: true } (subcommand is
 * optional).
 *
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  const tokens = argv.slice();

  // --help first-pass: allow anywhere.
  if (tokens.includes('--help')) {
    return { help: true, subcommand: null, positionals: [], flags: { help: true } };
  }

  while (tokens.length > 0) {
    const t = tokens.shift();
    if (t === '--') {
      // remaining tokens are positional
      for (const rest of tokens) positionals.push(rest);
      break;
    }
    if (t.startsWith('--')) {
      const spec = FLAG_SPECS[t];
      if (!spec) {
        const err = new Error(`unknown flag: ${t}`);
        err.usage = true;
        throw err;
      }
      if (spec.value) {
        if (tokens.length === 0) {
          const err = new Error(`flag ${t} requires a value`);
          err.usage = true;
          throw err;
        }
        flags[spec.key] = tokens.shift();
      } else {
        flags[spec.key] = true;
      }
    } else {
      positionals.push(t);
    }
  }

  if (positionals.length === 0) {
    const err = new Error('missing subcommand (expected one of music|voice|sfx|voices)');
    err.usage = true;
    throw err;
  }

  const subcommand = positionals.shift();
  if (!SUBCOMMANDS.has(subcommand)) {
    const err = new Error(
      `unknown subcommand: ${subcommand} (expected one of music|voice|sfx|voices)`
    );
    err.usage = true;
    throw err;
  }

  return { help: false, subcommand, positionals, flags };
}

// ────────────────────────────────────────────────────────────────────
// Help
// ────────────────────────────────────────────────────────────────────

const HELP_TEXT = `audiogen — generate game audio via ElevenLabs

Usage:
  node generate.cjs <subcommand> [prompt_or_query_words...] [options]

Subcommands:
  music  <prompt...>         Generate a music track.
  voice  <text...>           Generate TTS audio; requires --voice-id.
  sfx    <prompt...>         Generate a sound effect.
  voices [query...]          List/search voices; populates local cache.

Common options:
  --output PATH              Explicit output path or directory.
  --output-format FMT        Default mp3_44100_128.
  --seed N                   Integer seed (where supported).
  --model-id ID              Override the endpoint's default model.
  --dry-run                  Print resolved request + output path; no network.
  --force                    Overwrite existing output file (disables auto-version).
  --history-id ID            Group-tag for iteration threads.
  --history-parent ID        Parent record's id; marks this as a derivative.
  --help                     Show usage.

Music-only:
  --length-ms MS             3000-600000. Default 30000.
  --force-instrumental       No vocals.

Voice-only:
  --voice-id ID_OR_NAME      Required. Exact name in cache (case-insensitive),
                              or 20-char alphanumeric voice-id passthrough.
  --language-code CODE       e.g. en, ja.
  --stability N              0-1.
  --similarity-boost N       0-1.
  --style N                  0-1.
  --speed N                  0.5-2.

SFX-only:
  --duration N               0.5-30 seconds. Optional (API auto-derives).
  --loop                     Native API flag (v2 model only).
  --prompt-influence N       0-1. Default 0.3.

Voices-only:
  --language CODE            Filter by language.
  --gender male|female       Filter.
  --accent STR               Substring match on accent labels.
  --category STR             e.g. premade, cloned, professional.
  --json                     Emit raw JSON instead of table.
  --refresh                  Ignore cache, re-fetch.
  --page-size N              Override pagination page size (default 100, max 100).
`;

function printHelp() {
  process.stdout.write(HELP_TEXT);
}

// ────────────────────────────────────────────────────────────────────
// HTTP helper (ElevenLabs)
// ────────────────────────────────────────────────────────────────────

const RETRY_STATUSES = new Set([429, 500, 502, 503]);
const BASE_URL = 'https://api.elevenlabs.io';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(header) {
  if (!header) return null;
  const n = Number(header);
  if (Number.isFinite(n) && n >= 0) return Math.min(n, 30) * 1000;
  // HTTP-date form
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) {
    const wait = Math.max(0, dateMs - Date.now());
    return Math.min(wait, 30_000);
  }
  return null;
}

async function parseErrorBody(response) {
  const raw = await response.text();
  let message = raw;
  try {
    const obj = JSON.parse(raw);
    message =
      (obj && obj.detail && typeof obj.detail === 'object' && obj.detail.message) ||
      (obj && typeof obj.detail === 'string' && obj.detail) ||
      (obj && obj.message) ||
      raw;
  } catch (_e) {
    // leave as raw
  }
  return { message: (message || '').slice(0, 2000), raw };
}

/**
 * callElevenLabs — central HTTP helper.
 *
 * Retry: 3 attempts on 429/500/502/503. Backoff 1000ms * 2^(n-1) + up to
 * 500ms jitter. 429 honors Retry-After (clamped to 30s). 120s abort
 * per attempt via AbortSignal.timeout.
 *
 * Non-retryable (400/401/402/403/404/413/422) goes through fail(); 422
 * mentioning `output_format` appends the free-tier hint.
 *
 * responseType:
 *   'binary' — stream body to outputPath; fail on 0-byte response.
 *   'json'   — parse and return the object; outputPath ignored.
 *
 * @param {object} opts
 * @param {string} [opts.method]  default 'POST'
 * @param {string} opts.path
 * @param {Record<string,string>} [opts.query]
 * @param {object} [opts.body]
 * @param {string} [opts.outputPath]
 * @param {'binary'|'json'} [opts.responseType]  default 'binary'
 * @param {typeof fetch} [opts.fetchImpl]  injectable for tests
 * @returns {Promise<{ requestId?: string, bytesWritten?: number, json?: any }>}
 */
async function callElevenLabs(opts) {
  const {
    method = 'POST',
    path: urlPath,
    query,
    body,
    outputPath,
    responseType = 'binary',
    fetchImpl = fetch,
  } = opts;

  assertApiKey();
  const key = process.env.ELEVENLABS_API_KEY;

  const qs = query
    ? '?' +
      Object.entries(query)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&')
    : '';
  const url = `${BASE_URL}${urlPath}${qs}`;

  const init = {
    method,
    headers: {
      'xi-api-key': key,
      'content-type': 'application/json',
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const signal = AbortSignal.timeout(120_000);
    let response;
    try {
      response = await fetchImpl(url, { ...init, signal });
    } catch (e) {
      lastErr = e;
      if (attempt >= 3) {
        fail(`network error after 3 attempts: ${e && e.message ? e.message : e}`, {
          endpoint: `${method} ${url}`,
        });
      }
      await sleep(1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500));
      continue;
    }

    if (RETRY_STATUSES.has(response.status) && attempt < 3) {
      const retryAfter =
        response.status === 429 ? parseRetryAfter(response.headers.get('retry-after')) : null;
      const backoff =
        retryAfter !== null
          ? retryAfter
          : 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
      // drain body to free connection
      try {
        await response.text();
      } catch (_e) {}
      await sleep(backoff);
      continue;
    }

    const requestId = response.headers.get('xi-request-id') || undefined;

    if (!response.ok) {
      const { message } = await parseErrorBody(response);
      const details = {
        endpoint: `${method} ${url}`,
        status: `${response.status} ${response.statusText || ''}`.trim(),
        detail: message,
        'request-id': requestId,
      };
      if (
        response.status === 422 &&
        typeof message === 'string' &&
        /output_format/i.test(message)
      ) {
        details.hint =
          'Free-tier accounts are restricted to mp3_44100_64. Try --output-format mp3_44100_64.';
      }
      fail(`ElevenLabs request failed (${response.status})`, details);
    }

    if (responseType === 'json') {
      const raw = await response.text();
      try {
        return { requestId, json: JSON.parse(raw) };
      } catch (e) {
        fail(`unexpected non-JSON success body: ${raw.slice(0, 500)}`, {
          endpoint: `${method} ${url}`,
          'request-id': requestId,
          parse: e && e.message,
        });
      }
    }

    // binary
    const ct = response.headers.get('content-type') || '';
    if (/application\/json/i.test(ct)) {
      const raw = await response.text();
      fail(`unexpected JSON success body: ${raw.slice(0, 500)}`, {
        endpoint: `${method} ${url}`,
        'request-id': requestId,
      });
    }
    if (!outputPath) {
      fail('internal error: binary response requires outputPath');
    }
    mkdirpParent(outputPath);
    const ws = fs.createWriteStream(outputPath);
    await pipeline(Readable.fromWeb(response.body), ws);
    const stat = fs.statSync(outputPath);
    if (stat.size === 0) {
      try {
        fs.unlinkSync(outputPath);
      } catch (_e) {}
      fail('empty audio response; refine prompt or retry.', {
        endpoint: `${method} ${url}`,
        'request-id': requestId,
      });
    }
    return { requestId, bytesWritten: stat.size };
  }

  // Exhausted retries with retryable statuses.
  fail(`request failed after 3 attempts`, {
    endpoint: `${method} ${url}`,
    detail: lastErr && lastErr.message,
  });
}

// ────────────────────────────────────────────────────────────────────
// Subcommand stubs (phases 2-4 implement these)
// ────────────────────────────────────────────────────────────────────

async function runMusic(_parsed) {
  throw new Error('not yet implemented');
}
async function runTTS(_parsed) {
  throw new Error('not yet implemented');
}
async function runSFX(_parsed) {
  throw new Error('not yet implemented');
}
async function runVoicesList(_parsed) {
  throw new Error('not yet implemented');
}

// ────────────────────────────────────────────────────────────────────
// Main entry
// ────────────────────────────────────────────────────────────────────

async function main(argv) {
  assertNodeVersion();
  loadEnv();

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    if (e && e.usage) {
      process.stderr.write(`audiogen: ${e.message}\n\n`);
      process.stderr.write(HELP_TEXT);
      process.exit(1);
    }
    throw e;
  }

  if (parsed.help) {
    printHelp();
    process.exit(0);
  }

  const { subcommand, flags } = parsed;

  if (flags.dryRun) {
    // Print a dry-run block. Phases 2-4 add richer bodies; Phase 1 prints
    // just enough to satisfy the acceptance criteria's dry-run assertions.
    const outputFormat = flags.outputFormat || 'mp3_44100_128';
    const prompt = parsed.positionals.join(' ');
    let url = '';
    let requestBody = {};
    const tz = 'America/New_York';

    if (subcommand === 'music') {
      url = `${BASE_URL}/v1/music?output_format=${encodeURIComponent(outputFormat)}`;
      requestBody = {
        prompt,
        music_length_ms: flags.lengthMs ? Number(flags.lengthMs) : 30000,
      };
      if (flags.forceInstrumental) requestBody.force_instrumental = true;
      if (flags.modelId) requestBody.model_id = flags.modelId;
    } else if (subcommand === 'voice') {
      const voiceId = flags.voiceId || '<voice-id>';
      url = `${BASE_URL}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`;
      requestBody = { text: prompt };
      if (flags.modelId) requestBody.model_id = flags.modelId;
      if (flags.languageCode) requestBody.language_code = flags.languageCode;
      const vs = {};
      if (flags.stability !== undefined) vs.stability = Number(flags.stability);
      if (flags.similarityBoost !== undefined)
        vs.similarity_boost = Number(flags.similarityBoost);
      if (flags.style !== undefined) vs.style = Number(flags.style);
      if (flags.speed !== undefined) vs.speed = Number(flags.speed);
      if (Object.keys(vs).length > 0) requestBody.voice_settings = vs;
      if (flags.seed !== undefined) requestBody.seed = Number(flags.seed);
    } else if (subcommand === 'sfx') {
      url = `${BASE_URL}/v1/sound-generation?output_format=${encodeURIComponent(outputFormat)}`;
      requestBody = { text: prompt };
      if (flags.duration !== undefined)
        requestBody.duration_seconds = Number(flags.duration);
      if (flags.promptInfluence !== undefined)
        requestBody.prompt_influence = Number(flags.promptInfluence);
      if (flags.loop) requestBody.loop = true;
      if (flags.modelId) requestBody.model_id = flags.modelId;
    } else if (subcommand === 'voices') {
      const q = {};
      if (prompt) q.search = prompt;
      if (flags.language) q.language = flags.language;
      if (flags.gender) q.gender = flags.gender;
      if (flags.accent) q.accent = flags.accent;
      if (flags.category) q.category = flags.category;
      q.page_size = String(flags.pageSize ? Math.min(100, Number(flags.pageSize)) : 100);
      const qs = Object.keys(q).length
        ? '?' +
          Object.entries(q)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join('&')
        : '';
      url = `${BASE_URL}/v2/voices${qs}`;
      requestBody = null; // GET, no body
    }

    let outputPath = null;
    if (subcommand !== 'voices') {
      outputPath = resolveOutputPath({
        type: subcommand,
        prompt,
        outputOption: flags.output,
        outputFormat,
        force: !!flags.force,
        tz,
      });
    }

    // Human-readable block. No fs mutations, no mkdir, no writes.
    process.stdout.write(`audiogen dry-run (${subcommand})\n`);
    process.stdout.write(`  url: ${url}\n`);
    if (requestBody !== null) {
      process.stdout.write(`  body: ${JSON.stringify(requestBody)}\n`);
    } else {
      process.stdout.write(`  body: (GET)\n`);
    }
    if (outputPath) {
      process.stdout.write(`  output: ${outputPath}\n`);
    }
    process.exit(0);
  }

  // Live run — ensure API key and dispatch to subcommand stub.
  assertApiKey();
  try {
    if (subcommand === 'music') await runMusic(parsed);
    else if (subcommand === 'voice') await runTTS(parsed);
    else if (subcommand === 'sfx') await runSFX(parsed);
    else if (subcommand === 'voices') await runVoicesList(parsed);
  } catch (e) {
    fail(e && e.message ? e.message : String(e));
  }
}

// ────────────────────────────────────────────────────────────────────
// Exports for tests (when required, not run as CLI)
// ────────────────────────────────────────────────────────────────────

module.exports = {
  // core
  fail,
  loadEnv,
  assertNodeVersion,
  assertApiKey,
  // slug + paths
  slugify,
  timestampSlug,
  extFromOutputFormat,
  resolveOutputPath,
  mkdirpParent,
  // history
  appendHistory,
  // args
  parseArgs,
  FLAG_SPECS,
  SUBCOMMANDS,
  // http
  callElevenLabs,
  parseRetryAfter,
  // help
  HELP_TEXT,
  printHelp,
  // subcommand stubs
  runMusic,
  runTTS,
  runSFX,
  runVoicesList,
  // main (for integration tests)
  main,
};

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    fail(e && e.message ? e.message : String(e));
  });
}
