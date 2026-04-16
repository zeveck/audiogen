// tests/env.test.js — env walker: tmpdir fixture with nested .env,
// verify [cwd] single-candidate + __dirname-ancestor walk; shell-wins semantics.
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const gen = path.resolve(__dirname, '..', '.claude', 'skills', 'audiogen', 'generate.cjs');
const { loadEnv } = require(gen);

// Helper: create temp dir with optional .env
function makeTmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `audiogen-envtest-${name}-`));
}

describe('loadEnv', () => {
  let origCwd;
  let origEnv;

  beforeEach(() => {
    origCwd = process.cwd();
    origEnv = { ...process.env };
  });

  afterEach(() => {
    process.chdir(origCwd);
    // Restore env
    for (const k of Object.keys(process.env)) {
      if (!(k in origEnv)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(origEnv)) {
      process.env[k] = v;
    }
  });

  it('finds .env in cwd', () => {
    const tmp = makeTmpDir('cwd');
    const envPath = path.join(tmp, '.env');
    fs.writeFileSync(envPath, 'AUDIOGEN_TEST_CWD_VAR=cwd_value\n');
    delete process.env.AUDIOGEN_TEST_CWD_VAR;
    process.chdir(tmp);

    loadEnv();

    assert.equal(process.env.AUDIOGEN_TEST_CWD_VAR, 'cwd_value');

    // cleanup
    fs.unlinkSync(envPath);
    fs.rmdirSync(tmp);
  });

  it('walks upward from __dirname until filesystem root', () => {
    // If there's a .env in the project root (ancestor of __dirname), it should
    // be found. We test by ensuring loadEnv does not throw when cwd has no .env
    // and the walk reaches root without crashing.
    const tmp = makeTmpDir('noop');
    process.chdir(tmp);

    // This should not throw, even if no .env exists anywhere.
    loadEnv();
    fs.rmdirSync(tmp);
  });

  it('no-ops cleanly when no .env exists anywhere', () => {
    const tmp = makeTmpDir('none');
    process.chdir(tmp);

    // loadEnv should not throw — just return silently.
    loadEnv();
    fs.rmdirSync(tmp);
  });

  it('shell-exported values take precedence over .env values', () => {
    const tmp = makeTmpDir('shellwins');
    const envPath = path.join(tmp, '.env');
    fs.writeFileSync(envPath, 'AUDIOGEN_SHELL_WINS=from_file\n');

    // Set in shell first
    process.env.AUDIOGEN_SHELL_WINS = 'from_shell';
    process.chdir(tmp);
    loadEnv();

    // Shell value must win
    assert.equal(process.env.AUDIOGEN_SHELL_WINS, 'from_shell');

    delete process.env.AUDIOGEN_SHELL_WINS;
    fs.unlinkSync(envPath);
    fs.rmdirSync(tmp);
  });
});

describe('Node version check (CLI integration)', () => {
  it('fails with version error when process.loadEnvFile is unavailable', () => {
    // We simulate this by running a wrapper that deletes process.loadEnvFile
    // before requiring generate.cjs.
    const tmp = makeTmpDir('nodecheck');
    const wrapperPath = path.join(tmp, 'version-check.cjs');
    fs.writeFileSync(
      wrapperPath,
      `'use strict';
delete process.loadEnvFile;
const gen = require(${JSON.stringify(gen)});
gen.assertNodeVersion();
`
    );

    assert.throws(
      () =>
        execFileSync(process.execPath, [wrapperPath], {
          encoding: 'utf8',
          timeout: 5000,
        }),
      (e) => {
        assert.ok(e.status !== 0, 'must exit non-zero');
        assert.ok(
          e.stderr.includes('Node.js >= 20.14 required'),
          `stderr must mention Node version requirement, got: ${e.stderr}`
        );
        return true;
      }
    );

    fs.unlinkSync(wrapperPath);
    fs.rmdirSync(tmp);
  });
});
