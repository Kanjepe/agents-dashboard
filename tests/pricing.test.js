import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  familyFor,
  rateForModel,
  estimateCostUsd,
  getPricingTable,
  modelLabel,
} from '../lib/pricing.js';

// ─── familyFor ───────────────────────────────────────────────────────────────

test('familyFor: fable and mythos map to fable-5', () => {
  assert.equal(familyFor('claude-fable-5'), 'fable-5');
  assert.equal(familyFor('claude-mythos-5'), 'fable-5');
});

test('familyFor: modern opus (4.5+ and 5) maps to opus-modern', () => {
  assert.equal(familyFor('claude-opus-5'), 'opus-modern');
  assert.equal(familyFor('claude-opus-4-8'), 'opus-modern');
  assert.equal(familyFor('claude-opus-4-7'), 'opus-modern');
  assert.equal(familyFor('claude-opus-4-6'), 'opus-modern');
  assert.equal(familyFor('claude-opus-4-5-20251101'), 'opus-modern');
});

test('familyFor: old opus maps to opus-legacy', () => {
  assert.equal(familyFor('claude-opus-4-1-20250805'), 'opus-legacy');
  assert.equal(familyFor('claude-opus-4-20250514'), 'opus-legacy');
  assert.equal(familyFor('claude-3-opus-20240229'), 'opus-legacy');
});

test('familyFor: sonnet 5 is its own family, other sonnets generic', () => {
  assert.equal(familyFor('claude-sonnet-5'), 'sonnet-5');
  assert.equal(familyFor('claude-sonnet-4-6'), 'sonnet');
  assert.equal(familyFor('claude-sonnet-4-5-20250929'), 'sonnet');
});

test('familyFor: haiku families', () => {
  assert.equal(familyFor('claude-haiku-4-5-20251001'), 'haiku');
  assert.equal(familyFor('claude-3-5-haiku-20241022'), 'haiku-3.5');
});

test('familyFor: unknown model returns null', () => {
  assert.equal(familyFor('gpt-4o'), null);
  assert.equal(familyFor(''), null);
  assert.equal(familyFor(null), null);
});

// ─── rateForModel ────────────────────────────────────────────────────────────

test('rateForModel: fable 5 is $10/$50 with derived cache rates', () => {
  const r = rateForModel('claude-fable-5');
  assert.equal(r.input, 10);
  assert.equal(r.output, 50);
  assert.equal(r.cacheRead, 1);
  assert.equal(r.cacheCreate, 12.5);
  assert.equal(r.cacheCreate1h, 20);
});

test('rateForModel: modern opus is $5/$25', () => {
  const r = rateForModel('claude-opus-5');
  assert.equal(r.input, 5);
  assert.equal(r.output, 25);
  assert.equal(r.cacheRead, 0.5);
  assert.equal(r.cacheCreate, 6.25);
});

test('rateForModel: legacy opus keeps $15/$75', () => {
  const r = rateForModel('claude-opus-4-1-20250805');
  assert.equal(r.input, 15);
  assert.equal(r.output, 75);
});

test('rateForModel: sonnet 5 intro pricing until 2026-09-01', () => {
  const intro = rateForModel('claude-sonnet-5', '2026-08-04T12:00:00Z');
  assert.equal(intro.input, 2);
  assert.equal(intro.output, 10);
  const full = rateForModel('claude-sonnet-5', '2026-09-15T12:00:00Z');
  assert.equal(full.input, 3);
  assert.equal(full.output, 15);
});

test('rateForModel: [1m] premium requires the longContext flag (per-request, not per-model)', () => {
  // Without the flag the base rate applies — a [1m] model string alone is not enough.
  const sBase = rateForModel('claude-sonnet-4-5-20250929[1m]');
  assert.equal(sBase.input, 3);
  assert.equal(sBase.output, 15);
  const s = rateForModel('claude-sonnet-4-5-20250929[1m]', null, { longContext: true });
  assert.equal(s.input, 6);
  assert.equal(s.output, 22.5);
  const o46 = rateForModel('claude-opus-4-6[1m]', null, { longContext: true });
  assert.equal(o46.input, 10);
  assert.equal(o46.output, 37.5);
  // 4.7+/5/Fable have standard 1M pricing — no premium even over 200K
  const o5 = rateForModel('claude-opus-5[1m]', null, { longContext: true });
  assert.equal(o5.input, 5);
  assert.equal(o5.output, 25);
  const f = rateForModel('claude-fable-5[1m]', null, { longContext: true });
  assert.equal(f.input, 10);
});

test('estimateCostUsd: [1m] premium kicks in only above 200K input-side tokens', () => {
  const model = 'claude-sonnet-4-5-20250929[1m]';
  // 100K input — below threshold, base rate
  assert.equal(estimateCostUsd({ input: 100_000 }, model), 0.3);
  // 1M input — above threshold, premium rate
  assert.equal(estimateCostUsd({ input: 1_000_000 }, model), 6);
  // cache reads count toward the threshold
  const withCache = estimateCostUsd({ input: 10_000, cacheRead: 500_000 }, model);
  assert.ok(Math.abs(withCache - 0.36) < 1e-9, `expected ~0.36, got ${withCache}`);
});

test('rateForModel: opus fast variants are $10/$50', () => {
  const r = rateForModel('claude-opus-4-6-fast');
  assert.equal(r.family, 'opus-fast');
  assert.equal(r.input, 10);
  assert.equal(r.output, 50);
});

test('rateForModel: unknown model is flagged as estimated', () => {
  assert.equal(rateForModel('mystery-model').estimated, true);
  assert.equal(rateForModel('claude-opus-5').estimated, undefined);
});

test('rateForModel: unknown model falls back to sonnet base rates', () => {
  const r = rateForModel('mystery-model');
  assert.equal(r.input, 3);
  assert.equal(r.output, 15);
});

// ─── estimateCostUsd ─────────────────────────────────────────────────────────

test('estimateCostUsd: 1M input tokens on opus 5 costs $5', () => {
  assert.equal(estimateCostUsd({ input: 1_000_000 }, 'claude-opus-5'), 5);
});

test('estimateCostUsd: fable 5 no longer priced as sonnet', () => {
  const cost = estimateCostUsd({ input: 1_000_000, output: 100_000 }, 'claude-fable-5');
  assert.equal(cost, 10 + 5); // $10 input + $5 output
});

test('estimateCostUsd: cacheCreate back-compat treated as 5m tier', () => {
  const cost = estimateCostUsd({ cacheCreate: 1_000_000 }, 'claude-sonnet-4-6');
  assert.equal(cost, 3.75);
});

test('estimateCostUsd: 5m and 1h cache writes priced separately', () => {
  const cost = estimateCostUsd(
    { cacheCreate5m: 1_000_000, cacheCreate1h: 1_000_000 },
    'claude-sonnet-4-6',
  );
  assert.equal(cost, 3.75 + 6);
});

test('estimateCostUsd: timestamp selects sonnet 5 intro tier', () => {
  const intro = estimateCostUsd({ input: 1_000_000 }, 'claude-sonnet-5', '2026-08-04T12:00:00Z');
  assert.equal(intro, 2);
  const full = estimateCostUsd({ input: 1_000_000 }, 'claude-sonnet-5', '2026-10-01T12:00:00Z');
  assert.equal(full, 3);
});

// ─── getPricingTable ─────────────────────────────────────────────────────────

test('getPricingTable: includes fable and both opus generations', () => {
  const table = getPricingTable();
  const families = table.map((p) => p.family);
  assert.ok(families.includes('fable-5'));
  assert.ok(families.includes('opus-modern'));
  assert.ok(families.includes('opus-legacy'));
  assert.ok(families.includes('sonnet-5'));
  assert.ok(families.includes('haiku'));
});

// ─── modelLabel ──────────────────────────────────────────────────────────────

test('modelLabel: normalizes model ids to short labels', () => {
  assert.equal(modelLabel('claude-fable-5'), 'fable 5');
  assert.equal(modelLabel('claude-opus-4-8'), 'opus 4.8');
  assert.equal(modelLabel('claude-opus-5'), 'opus 5');
  assert.equal(modelLabel('claude-haiku-4-5-20251001'), 'haiku 4.5');
  assert.equal(modelLabel('claude-3-5-haiku-20241022'), 'haiku 3.5');
  assert.equal(modelLabel('claude-sonnet-5'), 'sonnet 5');
});

test('modelLabel: keeps [1m] marker and passes through unknowns', () => {
  assert.equal(modelLabel('claude-sonnet-4-5-20250929[1m]'), 'sonnet 4.5 [1m]');
  assert.equal(modelLabel('<synthetic>'), '<synthetic>');
});

test('modelLabel: keeps fast marker', () => {
  assert.equal(modelLabel('claude-opus-4-6-fast'), 'opus 4.6 fast');
});
