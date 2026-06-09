import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  parseFrontmatter,
  coerceField,
  skillGroup,
  isInsideDir,
} from '../lib/registry.js';

// ─── parseFrontmatter ────────────────────────────────────────────────────────

test('parseFrontmatter: basic key/value pairs', () => {
  const md = `---
name: foo
description: a tool
---
body text here`;
  const { fields, body } = parseFrontmatter(md);
  assert.equal(fields.name, 'foo');
  assert.equal(fields.description, 'a tool');
  assert.equal(body, 'body text here');
});

test('parseFrontmatter: no frontmatter returns empty fields + raw body', () => {
  const md = 'just some markdown';
  const { fields, body } = parseFrontmatter(md);
  assert.deepEqual(fields, {});
  assert.equal(body, 'just some markdown');
});

test('parseFrontmatter: handles YAML folded block scalar `>-`', () => {
  const md = `---
name: x
description: >-
  this is a long
  folded description
  on multiple lines
---
body`;
  const { fields } = parseFrontmatter(md);
  assert.equal(fields.description, 'this is a long folded description on multiple lines');
});

test('parseFrontmatter: coerces array fields to comma-separated string', () => {
  const md = `---
name: tool
tools:
  - Read
  - Write
  - Bash
---
body`;
  const { fields } = parseFrontmatter(md);
  assert.equal(fields.tools, 'Read, Write, Bash');
});

test('parseFrontmatter: malformed YAML returns empty fields without throwing', () => {
  const md = `---
name: ok
  bad: indentation: here:::
---
body`;
  // Contract: must not throw, must return an object as `fields`
  const result = parseFrontmatter(md);
  assert.equal(typeof result, 'object');
  assert.equal(typeof result.fields, 'object');
  assert.equal(typeof result.body, 'string');
});

// ─── coerceField ─────────────────────────────────────────────────────────────

test('coerceField: null/undefined returns empty string', () => {
  assert.equal(coerceField(null), '');
  assert.equal(coerceField(undefined), '');
});

test('coerceField: string passes through trimmed', () => {
  assert.equal(coerceField('  hello  '), 'hello');
});

test('coerceField: array joined with comma+space', () => {
  assert.equal(coerceField(['a', 'b', 'c']), 'a, b, c');
});

test('coerceField: object serialized as JSON', () => {
  assert.equal(coerceField({ a: 1 }), '{"a":1}');
});

// ─── skillGroup ──────────────────────────────────────────────────────────────

test('skillGroup: returns first dash-segment', () => {
  assert.equal(skillGroup('gsd-planner'), 'gsd');
  assert.equal(skillGroup('twino-skill-manager'), 'twino');
  assert.equal(skillGroup('n8n-workflow-patterns'), 'n8n');
});

test('skillGroup: returns prefix before colon for namespaced skills', () => {
  assert.equal(skillGroup('claude-mem:do'), 'claude-mem');
});

test('skillGroup: returns "misc" when no prefix', () => {
  assert.equal(skillGroup('roast'), 'misc');
});

// ─── isInsideDir (path traversal defense) ────────────────────────────────────

test('isInsideDir: same path returns true', () => {
  const dir = join(homedir(), '.claude', 'skills');
  assert.equal(isInsideDir(dir, dir), true);
});

test('isInsideDir: child path returns true', () => {
  const dir = join(homedir(), '.claude', 'skills');
  const child = join(dir, 'security-audit', 'SKILL.md');
  assert.equal(isInsideDir(child, dir), true);
});

test('isInsideDir: SECURITY — parent escape via .. returns false', () => {
  const dir = join(homedir(), '.claude', 'skills');
  const escape = join(dir, '..', '..', 'etc', 'passwd');
  assert.equal(isInsideDir(escape, dir), false);
});

test('isInsideDir: SECURITY — sibling directory returns false', () => {
  const dir = join(homedir(), '.claude', 'skills');
  const sibling = join(homedir(), '.claude', 'agents', 'gsd-planner.md');
  assert.equal(isInsideDir(sibling, dir), false);
});

test('isInsideDir: prefix-only collision returns false (skills vs skills-old)', () => {
  const dir = join(homedir(), '.claude', 'skills');
  const tricky = join(homedir(), '.claude', 'skills-old', 'something');
  assert.equal(isInsideDir(tricky, dir), false);
});
