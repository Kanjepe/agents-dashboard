import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  codexFamilyFor,
  codexRateForModel,
  codexEstimateCostUsd,
  getCodexPricingTable,
  codexModelLabel,
} from '../lib/codex-pricing.js';

// ─── codexFamilyFor ──────────────────────────────────────────────────────────

test('codexFamilyFor: maps observed models to families', () => {
  assert.equal(codexFamilyFor('gpt-6-astra'), 'gpt-6');
  assert.equal(codexFamilyFor('gpt-5.6-sol'), 'gpt-5.6');
  assert.equal(codexFamilyFor('gpt-5.5'), 'gpt-5.5');
  assert.equal(codexFamilyFor('gpt-5.4-mini'), 'gpt-5.4-mini');
  assert.equal(codexFamilyFor('some-future-model'), null);
  assert.equal(codexFamilyFor(null), null);
});

// ─── codexRateForModel ───────────────────────────────────────────────────────

test('codexRateForModel: gpt-6-astra standard and long-context rates', () => {
  const r = codexRateForModel('gpt-6-astra');
  assert.equal(r.input, 10);
  assert.equal(r.cachedInput, 1);
  assert.equal(r.output, 50);
  const long = codexRateForModel('gpt-6-astra', { longContext: true });
  assert.equal(long.input, 20);
  assert.equal(long.cachedInput, 2);
  assert.equal(long.output, 75);
});

test('codexEstimateCostUsd: gpt-6-astra splits cached vs uncached input', () => {
  // 200K input (below 272K threshold) of which 100K cached:
  // 100K × $10 + 100K × $1 = $1.10
  const cost = codexEstimateCostUsd({ input: 200_000, cachedInput: 100_000 }, 'gpt-6-astra');
  assert.ok(Math.abs(cost - 1.1) < 1e-9, `got ${cost}`);
});

test('codexRateForModel: gpt-5.6-sol standard rates', () => {
  const r = codexRateForModel('gpt-5.6-sol');
  assert.equal(r.input, 5);
  assert.equal(r.cachedInput, 0.5);
  assert.equal(r.output, 30);
});

test('codexRateForModel: long-context premium above 272K', () => {
  const r = codexRateForModel('gpt-5.5', { longContext: true });
  assert.equal(r.input, 10);
  assert.equal(r.cachedInput, 1);
  assert.equal(r.output, 45);
});

test('codexRateForModel: gpt-5.4-mini has no long-context tier', () => {
  const r = codexRateForModel('gpt-5.4-mini', { longContext: true });
  assert.equal(r.input, 0.75);
  assert.equal(r.cachedInput, 0.075);
  assert.equal(r.output, 4.5);
});

test('codexRateForModel: unknown model falls back with estimated flag', () => {
  const r = codexRateForModel('mystery-gpt');
  assert.equal(r.input, 5);
  assert.equal(r.estimated, true);
});

// ─── codexEstimateCostUsd ────────────────────────────────────────────────────

test('codexEstimateCostUsd: input INCLUDES cached — uncached portion at input rate', () => {
  // 200K input (below 272K threshold) of which 80K cached:
  // 120K × $5 + 80K × $0.50 = $0.64
  const cost = codexEstimateCostUsd({ input: 200_000, cachedInput: 80_000 }, 'gpt-5.5');
  assert.ok(Math.abs(cost - 0.64) < 1e-9, `got ${cost}`);
});

test('codexEstimateCostUsd: output billed at output rate', () => {
  const cost = codexEstimateCostUsd({ output: 1_000_000 }, 'gpt-5.6-sol');
  assert.equal(cost, 30);
});

test('codexEstimateCostUsd: long-context premium when input exceeds 272K', () => {
  const below = codexEstimateCostUsd({ input: 200_000 }, 'gpt-5.5');
  assert.ok(Math.abs(below - 1) < 1e-9, `got ${below}`); // 200K × $5
  const above = codexEstimateCostUsd({ input: 300_000 }, 'gpt-5.5');
  assert.ok(Math.abs(above - 3) < 1e-9, `got ${above}`); // 300K × $10
});

test('codexEstimateCostUsd: mini model', () => {
  const cost = codexEstimateCostUsd(
    { input: 1_000_000, cachedInput: 0, output: 100_000 },
    'gpt-5.4-mini',
  );
  assert.ok(Math.abs(cost - (0.75 + 0.45)) < 1e-9, `got ${cost}`);
});

// ─── getCodexPricingTable ────────────────────────────────────────────────────

test('getCodexPricingTable: includes all observed families with cachedInput', () => {
  const table = getCodexPricingTable();
  const families = table.map((p) => p.family);
  assert.ok(families.includes('gpt-6'));
  assert.ok(families.includes('gpt-5.6'));
  assert.ok(families.includes('gpt-5.5'));
  assert.ok(families.includes('gpt-5.4-mini'));
  assert.equal(typeof table[0].cachedInput, 'number');
});

// ─── codexModelLabel ─────────────────────────────────────────────────────────

test('codexModelLabel: passes model ids through', () => {
  assert.equal(codexModelLabel('gpt-5.6-sol'), 'gpt-5.6-sol');
  assert.equal(codexModelLabel(null), 'unknown');
});
