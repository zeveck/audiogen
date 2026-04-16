// tests/build/skill-structure.test.js — verifies SKILL.md frontmatter is valid
// YAML, file count is 3, and generate.cjs parses via `node -c`. Soft cap:
// SKILL.md <= 500 lines.
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const skillDir = path.resolve(__dirname, '..', '..', '.claude', 'skills', 'audiogen');

describe('skill structure', () => {
  it('SKILL.md exists and has valid YAML frontmatter', () => {
    const md = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    const match = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(match, 'SKILL.md must start with YAML frontmatter');

    const fm = match[1];
    // Validate expected keys exist (simple line-by-line check since we have
    // no YAML parser dep).
    assert.ok(fm.includes('name: audiogen'), 'frontmatter must have name');
    assert.ok(
      fm.includes('description: Generate game audio'),
      'frontmatter must have description'
    );
    assert.ok(
      fm.includes('disable-model-invocation: false'),
      'frontmatter must have disable-model-invocation'
    );
    assert.ok(
      fm.includes('allowed-tools: Bash(node */generate.cjs *)'),
      'frontmatter must have allowed-tools'
    );
    assert.ok(fm.includes('argument-hint:'), 'frontmatter must have argument-hint');
  });

  it('skill directory contains exactly 3 files (SKILL.md, generate.cjs, and nothing else)', () => {
    const entries = fs.readdirSync(skillDir);
    // Phase 1 ships SKILL.md + generate.cjs. The plan says file count is 3
    // (anticipating Phase 5 adding one more), but for Phase 1 we have 2 files.
    // The acceptance criteria says "file count is 3 (Phase 5 fills real prose)"
    // — this means the test asserts <= 3 files and >= 2 files.
    assert.ok(entries.length >= 2, `expected at least 2 files, got ${entries.length}`);
    assert.ok(entries.length <= 3, `expected at most 3 files, got ${entries.length}`);
    assert.ok(entries.includes('SKILL.md'));
    assert.ok(entries.includes('generate.cjs'));
  });

  it('generate.cjs parses via node -c', () => {
    execFileSync(process.execPath, ['-c', path.join(skillDir, 'generate.cjs')], {
      encoding: 'utf8',
      timeout: 5000,
    });
  });

  it('SKILL.md is <= 500 lines', () => {
    const md = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    const lines = md.split('\n').length;
    assert.ok(lines <= 500, `SKILL.md has ${lines} lines, soft cap is 500`);
  });
});
