// tests/build/skill-structure.test.js — verifies SKILL.md frontmatter is valid
// YAML, skill directory has SKILL.md + generate.cjs + reference.md, generate.cjs
// parses via `node -c`, and reference.md has all required sections with their
// minimum preset/archetype counts. Soft cap: SKILL.md <= 500 lines.
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

  it('skill directory contains SKILL.md, generate.cjs, and reference.md', () => {
    const entries = fs.readdirSync(skillDir);
    // Phase 5 lands reference.md, bringing the skill directory to exactly 3
    // files. Any additional files in this directory are likely a mistake
    // (everything else — tests, scripts, plans — lives outside the skill).
    assert.ok(entries.includes('SKILL.md'), 'SKILL.md must exist');
    assert.ok(entries.includes('generate.cjs'), 'generate.cjs must exist');
    assert.ok(entries.includes('reference.md'), 'reference.md must exist');
    assert.equal(
      entries.length,
      3,
      `skill dir must contain exactly 3 files, got ${entries.length}: ${entries.join(', ')}`
    );
  });

  it('generate.cjs parses via node -c', () => {
    execFileSync(process.execPath, ['-c', path.join(skillDir, 'generate.cjs')], {
      encoding: 'utf8',
      timeout: 5000,
    });
  });

  it('SKILL.md is <= 500 lines (soft cap)', () => {
    const md = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    const lines = md.split('\n').length;
    assert.ok(
      lines <= 500,
      `SKILL.md has ${lines} lines, exceeds 500-line soft cap; consider splitting into reference.md`
    );
  });

  it('SKILL.md contains all required load-bearing section headers', () => {
    const md = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    // Prose-flavored section headers — adapt if the headings are renamed, but
    // the underlying topics must still be present.
    const requiredHeadings = [
      /^#\s+\/audiogen\b/m,             // title
      /^##\s+Prerequisites\b/m,
      /^##\s+Quick Start\b/m,
      /^###\s+`music`/m,
      /^###\s+`voice`/m,
      /^###\s+`sfx`/m,
      /^###\s+`voices`/m,
      /^##\s+Output Organization\b/m,
      /^##\s+Confirmation Policy\b/m,
      /^##\s+Handling Errors\b/m,
      /^##\s+Regeneration & Iteration\b/m,
      /^##\s+Loop Caveat\b/m,
      /^##\s+Cost\b/m,
      /^##\s+Licensing\b/m,
      /^##\s+Key Rules\b/m,
      /^##\s+Edge Cases\b/m,
      /^##\s+Script Location\b/m,
    ];
    for (const re of requiredHeadings) {
      assert.match(md, re, `SKILL.md missing required section matching ${re}`);
    }
  });

  it('SKILL.md has no unfilled {{PLACEHOLDER}} strings', () => {
    const md = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    assert.doesNotMatch(md, /\{\{[A-Z_]+\}\}/, 'SKILL.md contains unfilled {{PLACEHOLDER}} strings');
  });

  it('reference.md exists and has Music / Voice / SFX / Cost sections', () => {
    const ref = fs.readFileSync(path.join(skillDir, 'reference.md'), 'utf8');
    assert.match(ref, /^##\s+Music Presets\b/m, 'reference.md missing ## Music Presets');
    assert.match(ref, /^##\s+Voice Archetypes\b/m, 'reference.md missing ## Voice Archetypes');
    assert.match(ref, /^##\s+SFX Presets\b/m, 'reference.md missing ## SFX Presets');
    assert.match(ref, /^##\s+Cost Reference\b/m, 'reference.md missing ## Cost Reference');
  });

  it('reference.md has >= 10 music presets', () => {
    const ref = fs.readFileSync(path.join(skillDir, 'reference.md'), 'utf8');
    // Music Presets section spans from its ## header to the next ## header.
    const section = extractSection(ref, 'Music Presets');
    // Count ### numbered entries in the section ("### 1. Foo", "### 2. Bar"...).
    const entries = section.match(/^###\s+\d+\.\s+/gm) || [];
    assert.ok(
      entries.length >= 10,
      `expected >= 10 music presets, got ${entries.length}`
    );
  });

  it('reference.md has >= 6 voice archetypes', () => {
    const ref = fs.readFileSync(path.join(skillDir, 'reference.md'), 'utf8');
    const section = extractSection(ref, 'Voice Archetypes');
    const entries = section.match(/^###\s+\d+\.\s+/gm) || [];
    assert.ok(
      entries.length >= 6,
      `expected >= 6 voice archetypes, got ${entries.length}`
    );
  });

  it('reference.md has >= 5 SFX categories with >= 3 examples each', () => {
    const ref = fs.readFileSync(path.join(skillDir, 'reference.md'), 'utf8');
    const section = extractSection(ref, 'SFX Presets');
    // Categories are ### headers WITHOUT a leading number (the category name).
    // Individual SFX entries are numbered list items (1. Foo).
    const categoryHeaders = section.match(/^###\s+(?!\d+\.)[^\n]+/gm) || [];
    assert.ok(
      categoryHeaders.length >= 5,
      `expected >= 5 SFX category headers, got ${categoryHeaders.length}`
    );

    // Count numbered list items in each category subsection.
    // Split the section by ### headers; for each subsection count numbered list items.
    const subsections = section.split(/^###\s+/m).slice(1); // drop content before first ###
    const sfxSubsections = subsections.filter((s) => !/^\d+\.\s+/.test(s));
    for (const sub of sfxSubsections) {
      const listItems = sub.match(/^\d+\.\s+\*\*/gm) || [];
      const subTitle = sub.split(/\r?\n/)[0].trim();
      assert.ok(
        listItems.length >= 3,
        `SFX category "${subTitle}" has ${listItems.length} examples, need >= 3`
      );
    }
  });

  it('reference.md cites the live pricing URL and marks numbers as non-authoritative', () => {
    const ref = fs.readFileSync(path.join(skillDir, 'reference.md'), 'utf8');
    assert.match(
      ref,
      /elevenlabs\.io\/pricing/i,
      'reference.md must cite the live pricing page URL'
    );
    assert.match(
      ref,
      /approximate|may lag|authoritative/i,
      'reference.md must label its rates as non-authoritative'
    );
  });

  it('reference.md has no unfilled {{PLACEHOLDER}} strings', () => {
    const ref = fs.readFileSync(path.join(skillDir, 'reference.md'), 'utf8');
    assert.doesNotMatch(
      ref,
      /\{\{[A-Z_]+\}\}/,
      'reference.md contains unfilled {{PLACEHOLDER}} strings'
    );
  });
});

/**
 * Extract the body of a `## <name>` section: from the line after the heading,
 * up to (but not including) the next `## ` heading or end of file.
 */
function extractSection(md, name) {
  const lines = md.split(/\r?\n/);
  const headerRe = new RegExp('^##\\s+' + name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + '\\b');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}
