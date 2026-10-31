// tests/plan.test.js — `plan` subcommand: reads /v1/user/subscription and
// says whether audio must credit ElevenLabs (free plan only).
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const gen = path.resolve(__dirname, '..', 'skills', 'audiogen', 'generate.cjs');
const { runPlan } = require(gen);

function plan(respond) {
  const calls = [];
  const out = { buf: '', write(c) { out.buf += c; return true; } };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return respond();
  };
  return runPlan({}, { fetchImpl, stdout: out }).then((result) => ({ result, calls, printed: JSON.parse(out.buf) }));
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status });

describe('plan', () => {
  let origKey;
  before(() => {
    origKey = process.env.ELEVENLABS_API_KEY;
    process.env.ELEVENLABS_API_KEY = 'test-key';
  });
  after(() => {
    if (origKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = origKey;
  });

  it('free plan: credit required, with credits left', async () => {
    const { result, calls, printed } = await plan(() =>
      json({ tier: 'free', character_count: 100, character_limit: 10000 }));
    assert.deepEqual(result, { plan: 'free', creditRequired: true, creditsLeft: 9900, creditLimit: 10000 });
    assert.deepEqual(printed, result);
    assert.equal(calls[0].url, 'https://api.elevenlabs.io/v1/user/subscription');
    assert.equal(calls[0].init.headers['xi-api-key'], 'test-key');
  });

  it('paid plan: no credit required', async () => {
    const { result } = await plan(() => json({ tier: 'creator' }));
    assert.deepEqual(result, { plan: 'creator', creditRequired: false });
  });

  it("a key that can't read the plan, or no connection: unknown, not an error", async () => {
    const denied = await plan(() => json({ detail: { status: 'missing_permissions' } }, 401));
    assert.equal(denied.result.plan, 'unknown');
    assert.equal(denied.result.creditRequired, null);
    assert.match(denied.result.reason, /couldn't read the plan/);

    const garbled = await plan(() => new Response('<html>proxy</html>'));
    assert.equal(garbled.result.plan, 'unknown');
    assert.match(garbled.result.reason, /didn't include the plan/);

    const offline = await plan(() => { throw new Error('getaddrinfo ENOTFOUND'); });
    assert.equal(offline.result.plan, 'unknown');
    assert.match(offline.result.reason, /couldn't reach/);
  });
});
