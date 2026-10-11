// tests/version.test.js — release version consistency (CalVer, plugin manifests, changelog).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const gen = path.join(root, 'skills', 'audiogen', 'generate.cjs');
const { AUDIOGEN_VERSION } = require(gen);

test('version is date-based CalVer', () => {
  assert.match(AUDIOGEN_VERSION, /^\d{4}\.\d{1,2}\.\d{1,2}$/);
});

test('CLI version matches plugin.json and the first CHANGELOG heading', () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/plugin.json'), 'utf8'));
  assert.equal(plugin.version, AUDIOGEN_VERSION);
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const first = changelog.match(/^## v(\S+)/m);
  assert.ok(first, 'CHANGELOG.md has a "## v" heading');
  assert.equal(first[1], AUDIOGEN_VERSION);
});

test('marketplace and plugin manifests point at the skill', () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/plugin.json'), 'utf8'));
  const market = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/marketplace.json'), 'utf8'));
  assert.equal(plugin.name, 'audiogen');
  assert.equal(market.name, 'audiogen');
  assert.deepEqual(market.plugins.map((p) => [p.name, p.source]), [['audiogen', '.']]);
  assert.ok(fs.existsSync(path.join(root, 'skills/audiogen/SKILL.md')));
  assert.ok(!fs.existsSync(path.join(root, '.claude/skills/audiogen')), 'skill moved to skills/audiogen');
  const skill = fs.readFileSync(path.join(root, 'skills/audiogen/SKILL.md'), 'utf8');
  assert.ok(skill.includes('Bash(node ${CLAUDE_SKILL_DIR}/generate.cjs *)'));
  assert.ok(!skill.includes('.claude/skills/audiogen'));
});

test('--version prints just the version; --help shows it', () => {
  const v = spawnSync(process.execPath, [gen, '--version'], { encoding: 'utf8' });
  assert.equal(v.status, 0);
  assert.equal(v.stdout, `${AUDIOGEN_VERSION}\n`);
  const h = spawnSync(process.execPath, [gen, '--help'], { encoding: 'utf8' });
  assert.ok(h.stdout.includes(`audiogen v${AUDIOGEN_VERSION}`));
});
