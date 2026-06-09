import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeJson, detectClaudeProcesses } from '../lib/processes.js';

// ─── safeJson ────────────────────────────────────────────────────────────────

test('safeJson: valid JSON object', () => {
  assert.deepEqual(safeJson('{"a":1,"b":"x"}'), { a: 1, b: 'x' });
});

test('safeJson: valid JSON array', () => {
  assert.deepEqual(safeJson('[1,2,3]'), [1, 2, 3]);
});

test('safeJson: empty string returns null (not undefined, not error)', () => {
  assert.equal(safeJson(''), null);
});

test('safeJson: null input returns null', () => {
  assert.equal(safeJson(null), null);
});

test('safeJson: undefined input returns null', () => {
  assert.equal(safeJson(undefined), null);
});

test('safeJson: malformed JSON returns null (does not throw)', () => {
  assert.equal(safeJson('{not valid}'), null);
  assert.equal(safeJson('{"a":'), null);
  assert.equal(safeJson('garbage 123 abc'), null);
});

test('safeJson: valid number/string/bool primitives', () => {
  assert.equal(safeJson('42'), 42);
  assert.equal(safeJson('"hi"'), 'hi');
  assert.equal(safeJson('true'), true);
});

// ─── detectClaudeProcesses (smoke test) ──────────────────────────────────────

test('detectClaudeProcesses: returns an array without throwing', async () => {
  const procs = await detectClaudeProcesses();
  assert.ok(Array.isArray(procs), 'expected an array');
  // We don't assert on length — it depends on what's running locally.
  // Just verify the shape of any returned items.
  for (const p of procs) {
    assert.equal(typeof p.pid, 'number', 'each process must have numeric pid');
  }
});

test('detectClaudeProcesses: second call returns same shape (cache path)', async () => {
  const first = await detectClaudeProcesses();
  const second = await detectClaudeProcesses();
  assert.ok(Array.isArray(first) && Array.isArray(second));
  // Both should be arrays; cache-served result has same structure.
  if (first.length > 0 && second.length > 0) {
    assert.equal(typeof first[0].pid, typeof second[0].pid);
  }
});
