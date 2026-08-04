import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseRolloutContent } from '../lib/codex.js';

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex-rollout.jsonl');
const fixture = readFileSync(fixturePath, 'utf8');

test('parseRolloutContent: extracts project name from session_meta cwd', () => {
  const { projectName } = parseRolloutContent(fixture);
  assert.equal(projectName, 'my-codex-project');
});

test('parseRolloutContent: one event per token_count with per-turn usage', () => {
  const { events } = parseRolloutContent(fixture);
  assert.equal(events.length, 2);
  assert.equal(events[0].usage.input, 20047);
  assert.equal(events[0].usage.cachedInput, 0);
  assert.equal(events[0].usage.output, 26);
  assert.equal(events[0].usage.total, 20073);
  // second event uses last_token_usage (per-turn), not the cumulative total
  assert.equal(events[1].usage.input, 20096);
  assert.equal(events[1].usage.cachedInput, 19200);
  assert.equal(events[1].usage.total, 20548);
});

test('parseRolloutContent: tracks model switches via turn_context', () => {
  const { events } = parseRolloutContent(fixture);
  assert.equal(events[0].model, 'gpt-5.5');
  assert.equal(events[1].model, 'gpt-5.6-sol');
});

test('parseRolloutContent: survives garbage lines and empty input', () => {
  assert.doesNotThrow(() => parseRolloutContent(''));
  const { events } = parseRolloutContent('garbage\n{"broken json');
  assert.equal(events.length, 0);
});
