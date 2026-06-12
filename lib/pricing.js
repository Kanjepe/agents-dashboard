// Per-model pricing in USD per 1,000,000 tokens.
// Numbers reflect Anthropic public pricing for the model families used by Claude Code.
// Update when Anthropic changes published prices.

const PRICING = {
  // Opus 4.x (incl. 4.5/4.6/4.7) — default 200k context
  opus: { input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 },
  // Opus 4.x — 1M context variant (2x base)
  'opus-1m': { input: 30, output: 150, cacheRead: 3, cacheCreate: 37.5 },
  // Sonnet 4.x (incl. 3.7/4.5/4.6) — default 200k context
  sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 },
  // Sonnet 4.x — 1M context variant
  'sonnet-1m': { input: 6, output: 22.5, cacheRead: 0.6, cacheCreate: 7.5 },
  // Haiku 4.5
  haiku: { input: 1, output: 5, cacheRead: 0.1, cacheCreate: 1.25 },
  // Haiku 3.5
  'haiku-3.5': { input: 0.8, output: 4, cacheRead: 0.08, cacheCreate: 1 },
};

const DEFAULT = PRICING.sonnet;

function familyFor(model) {
  if (!model) return null;
  const m = String(model).toLowerCase();
  const has1m = m.includes('[1m]');
  if (m.includes('opus')) return has1m ? 'opus-1m' : 'opus';
  if (m.includes('sonnet')) return has1m ? 'sonnet-1m' : 'sonnet';
  if (m.includes('haiku-3.5') || m.includes('haiku-3-5')) return 'haiku-3.5';
  if (m.includes('haiku')) return 'haiku';
  return null;
}

export function estimateCostUsd({ input = 0, output = 0, cacheRead = 0, cacheCreate = 0 }, model) {
  const family = familyFor(model);
  const p = (family && PRICING[family]) || DEFAULT;
  const cost =
    (input * p.input +
      output * p.output +
      cacheRead * p.cacheRead +
      cacheCreate * p.cacheCreate) /
    1_000_000;
  return Math.round(cost * 10000) / 10000;
}
