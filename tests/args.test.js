// tests/args.test.js — CLI grammar: subcommand parsing, flag extraction,
// unknown-flag error, --help, routing stubs.
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const gen = path.resolve(__dirname, '..', '.claude', 'skills', 'audiogen', 'generate.cjs');
const { parseArgs, SUBCOMMANDS, FLAG_SPECS } = require(gen);

describe('parseArgs', () => {
  it('parses music subcommand with positionals', () => {
    const r = parseArgs(['music', 'epic', 'battle', 'theme']);
    assert.equal(r.subcommand, 'music');
    assert.deepEqual(r.positionals, ['epic', 'battle', 'theme']);
    assert.equal(r.help, false);
  });

  it('parses voice subcommand', () => {
    const r = parseArgs(['voice', 'hello', 'world', '--voice-id', 'abc123']);
    assert.equal(r.subcommand, 'voice');
    assert.deepEqual(r.positionals, ['hello', 'world']);
    assert.equal(r.flags.voiceId, 'abc123');
  });

  it('parses sfx subcommand', () => {
    const r = parseArgs(['sfx', 'explosion']);
    assert.equal(r.subcommand, 'sfx');
    assert.deepEqual(r.positionals, ['explosion']);
  });

  it('parses voices subcommand', () => {
    const r = parseArgs(['voices', '--language', 'en']);
    assert.equal(r.subcommand, 'voices');
    assert.equal(r.flags.language, 'en');
  });

  it('parses --output flag', () => {
    const r = parseArgs(['music', 'test', '--output', '/tmp/out.mp3']);
    assert.equal(r.flags.output, '/tmp/out.mp3');
  });

  it('parses --output-format flag', () => {
    const r = parseArgs(['music', 'test', '--output-format', 'mp3_44100_64']);
    assert.equal(r.flags.outputFormat, 'mp3_44100_64');
  });

  it('parses --seed flag', () => {
    const r = parseArgs(['music', 'test', '--seed', '42']);
    assert.equal(r.flags.seed, '42');
  });

  it('parses --model-id flag', () => {
    const r = parseArgs(['music', 'test', '--model-id', 'eleven_v3']);
    assert.equal(r.flags.modelId, 'eleven_v3');
  });

  it('parses --force as boolean', () => {
    const r = parseArgs(['music', 'test', '--force']);
    assert.equal(r.flags.force, true);
  });

  it('parses --dry-run as boolean', () => {
    const r = parseArgs(['music', 'test', '--dry-run']);
    assert.equal(r.flags.dryRun, true);
  });

  it('flags may appear anywhere after subcommand', () => {
    const r = parseArgs(['sfx', '--duration', '5', 'whoosh', '--loop']);
    assert.equal(r.subcommand, 'sfx');
    assert.deepEqual(r.positionals, ['whoosh']);
    assert.equal(r.flags.duration, '5');
    assert.equal(r.flags.loop, true);
  });

  it('throws on unknown flag', () => {
    assert.throws(
      () => parseArgs(['music', 'test', '--bogus']),
      (e) => e.message.includes('unknown flag') && e.usage === true
    );
  });

  it('throws on unknown subcommand', () => {
    assert.throws(
      () => parseArgs(['dance', 'test']),
      (e) => e.message.includes('unknown subcommand') && e.usage === true
    );
  });

  it('throws on missing subcommand', () => {
    assert.throws(
      () => parseArgs([]),
      (e) => e.message.includes('missing subcommand') && e.usage === true
    );
  });

  it('throws when flag requires a value but none given', () => {
    assert.throws(
      () => parseArgs(['music', 'test', '--seed']),
      (e) => e.message.includes('requires a value')
    );
  });

  it('returns help: true when --help appears anywhere', () => {
    const r1 = parseArgs(['--help']);
    assert.equal(r1.help, true);
    const r2 = parseArgs(['music', '--help']);
    assert.equal(r2.help, true);
    const r3 = parseArgs(['--help', 'sfx', 'boom']);
    assert.equal(r3.help, true);
  });

  it('routes all four subcommands', () => {
    for (const sub of ['music', 'voice', 'sfx', 'voices']) {
      const r = parseArgs([sub, 'test']);
      assert.equal(r.subcommand, sub);
    }
  });
});

describe('--help CLI integration', () => {
  it('exits 0 and prints usage text', () => {
    const out = execFileSync(process.execPath, [gen, '--help'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.ok(out.includes('Subcommands:'));
    assert.ok(out.includes('music'));
    assert.ok(out.includes('voice'));
    assert.ok(out.includes('sfx'));
    assert.ok(out.includes('voices'));
    assert.ok(out.includes('--output'));
    assert.ok(out.includes('--output-format'));
    assert.ok(out.includes('--seed'));
    assert.ok(out.includes('--model-id'));
    assert.ok(out.includes('--dry-run'));
    assert.ok(out.includes('--force'));
    assert.ok(out.includes('--history-id'));
    assert.ok(out.includes('--history-parent'));
    assert.ok(out.includes('--help'));
    assert.ok(out.includes('--length-ms'));
    assert.ok(out.includes('--force-instrumental'));
    assert.ok(out.includes('--voice-id'));
    assert.ok(out.includes('--language-code'));
    assert.ok(out.includes('--stability'));
    assert.ok(out.includes('--similarity-boost'));
    assert.ok(out.includes('--style'));
    assert.ok(out.includes('--speed'));
    assert.ok(out.includes('--duration'));
    assert.ok(out.includes('--loop'));
    assert.ok(out.includes('--prompt-influence'));
    assert.ok(out.includes('--language'));
    assert.ok(out.includes('--gender'));
    assert.ok(out.includes('--accent'));
    assert.ok(out.includes('--category'));
    assert.ok(out.includes('--json'));
    assert.ok(out.includes('--refresh'));
    assert.ok(out.includes('--page-size'));
  });
});

describe('missing subcommand CLI integration', () => {
  it('exits non-zero with a clear error', () => {
    assert.throws(
      () =>
        execFileSync(process.execPath, [gen], {
          encoding: 'utf8',
          timeout: 5000,
        }),
      (e) => {
        assert.ok(e.status !== 0, 'exit code must be non-zero');
        assert.ok(
          e.stderr.includes('missing subcommand'),
          `stderr should mention 'missing subcommand', got: ${e.stderr}`
        );
        return true;
      }
    );
  });
});
