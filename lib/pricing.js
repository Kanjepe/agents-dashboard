// Per-model pricing in USD per 1,000,000 tokens.
// Matched by exact model ID patterns (first rule wins) so that legacy models
// keep their launch-era prices and retrospective cost reports stay accurate.
// Sources: Anthropic public pricing (platform.claude.com/docs/en/pricing).
// Cache rates are derived from input price: read = 0.1x, 5m write = 1.25x,
// 1h write = 2x. A family may set a flat `cacheRead` to override the derived
// rate (Fable 5.1 cut cache reads to $0.25/MTok, 75% below the derived rate).

// Date the table was last checked against Anthropic public pricing.
// Surface this in the UI so staleness is visible, not silent.
export const PRICING_VERIFIED_AT = '2026-09-07';

// tiers: optional date-dependent overrides, checked in order; an entry applies
// when the usage timestamp is strictly before its `until` (YYYY-MM-DD).
const FAMILIES = [
  {
    family: 'fable-5.1',
    label: 'fable 5.1 / mythos 5.1',
    match: (m) => /fable-5-1|mythos-5-1/.test(m),
    input: 10,
    output: 50,
    cacheRead: 0.25,
    longContextPremium: false,
  },
  {
    family: 'fable-5',
    label: 'fable 5 / mythos 5',
    match: (m) => m.includes('fable') || m.includes('mythos'),
    input: 10,
    output: 50,
    longContextPremium: false,
  },
  {
    // Fast-mode variants (e.g. legacy claude-opus-4-6-fast) bill at premium
    // rates — $10/$50 per Anthropic fast-mode pricing.
    family: 'opus-fast',
    label: 'opus fast',
    match: (m) => m.includes('opus') && m.includes('fast'),
    input: 10,
    output: 50,
    longContextPremium: false,
  },
  {
    family: 'opus-modern',
    label: 'opus 4.5 – 5',
    match: (m) =>
      m.includes('opus') &&
      /opus-5|opus-4-[5678]/.test(m),
    input: 5,
    output: 25,
    // 1M-context premium existed only up to opus 4.6
    longContextPremium: (m) => /opus-4-[56]/.test(m),
  },
  {
    family: 'opus-legacy',
    label: 'opus ≤ 4.1',
    match: (m) => m.includes('opus'),
    input: 15,
    output: 75,
    longContextPremium: true,
  },
  {
    family: 'sonnet-5',
    label: 'sonnet 5',
    match: (m) => /sonnet-5/.test(m),
    input: 3,
    output: 15,
    tiers: [{ until: '2026-09-01', input: 2, output: 10 }],
    longContextPremium: false,
  },
  {
    family: 'sonnet',
    label: 'sonnet ≤ 4.6',
    match: (m) => m.includes('sonnet'),
    input: 3,
    output: 15,
    longContextPremium: true,
  },
  {
    family: 'haiku-3.5',
    label: 'haiku 3.5',
    match: (m) => m.includes('haiku-3.5') || m.includes('haiku-3-5') || /3-5-haiku/.test(m),
    input: 0.8,
    output: 4,
    longContextPremium: false,
  },
  {
    family: 'haiku',
    label: 'haiku 4.5',
    match: (m) => m.includes('haiku'),
    input: 1,
    output: 5,
    longContextPremium: false,
  },
];

const DEFAULT_FAMILY = 'sonnet';

function findFamily(model) {
  if (!model) return null;
  const m = String(model).toLowerCase();
  return FAMILIES.find((f) => f.match(m)) || null;
}

export function familyFor(model) {
  const f = findFamily(model);
  return f ? f.family : null;
}

function baseRates(f, timestamp) {
  if (f.tiers && timestamp) {
    // Local calendar day, consistent with dayKey() bucketing everywhere else.
    const d = new Date(timestamp);
    const day = Number.isNaN(d.getTime())
      ? String(timestamp).slice(0, 10)
      : d.toLocaleDateString('sv-SE');
    for (const tier of f.tiers) {
      if (day < tier.until) return { input: tier.input, output: tier.output };
    }
  }
  return { input: f.input, output: f.output };
}

// The >200K long-context premium is per REQUEST (input-side token volume),
// not per model string — callers pass longContext when a single message's
// input side actually exceeded the threshold.
function buildRate(f, model, timestamp, longContext = false) {
  let { input, output } = baseRates(f, timestamp);

  const has1m = model ? String(model).toLowerCase().includes('[1m]') : false;
  const premium =
    typeof f.longContextPremium === 'function'
      ? f.longContextPremium(String(model || '').toLowerCase())
      : f.longContextPremium;
  const applyPremium = has1m && premium && longContext;
  if (applyPremium) {
    input *= 2;
    output *= 1.5;
  }

  return {
    family: f.family,
    label: applyPremium ? `${f.label} [1M ctx]` : f.label,
    input,
    output,
    cacheRead: f.cacheRead ?? input * 0.1,
    cacheCreate: input * 1.25,
    cacheCreate1h: input * 2,
  };
}

export function rateForModel(model, timestamp, { longContext = false } = {}) {
  const f = findFamily(model);
  const rate = buildRate(
    f || FAMILIES.find((x) => x.family === DEFAULT_FAMILY),
    model,
    timestamp,
    longContext,
  );
  if (!f) rate.estimated = true;
  return rate;
}

export function getPricingTable() {
  const now = new Date().toISOString();
  return FAMILIES.map((f) => buildRate(f, null, now));
}

const LONG_CONTEXT_THRESHOLD = 200_000;

// cacheCreate (legacy field) is treated as a 5-minute-TTL write; callers that
// know the TTL split pass cacheCreate5m / cacheCreate1h instead.
// Returns an UNROUNDED figure — round once at the display/aggregation boundary,
// not per message (per-message rounding systematically drops micro-costs).
export function estimateCostUsd(
  { input = 0, output = 0, cacheRead = 0, cacheCreate = 0, cacheCreate5m = 0, cacheCreate1h = 0 },
  model,
  timestamp,
) {
  const inputSide = input + cacheRead + cacheCreate + cacheCreate5m + cacheCreate1h;
  const p = rateForModel(model, timestamp, { longContext: inputSide > LONG_CONTEXT_THRESHOLD });
  return (
    (input * p.input +
      output * p.output +
      cacheRead * p.cacheRead +
      (cacheCreate + cacheCreate5m) * p.cacheCreate +
      cacheCreate1h * p.cacheCreate1h) /
    1_000_000
  );
}

// "claude-haiku-4-5-20251001" → "haiku 4.5", "claude-3-5-haiku-..." → "haiku 3.5"
const FAMILY_WORDS = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'];

export function modelLabel(model) {
  if (!model) return 'unknown';
  const raw = String(model);
  const has1m = raw.toLowerCase().includes('[1m]');
  let m = raw.toLowerCase().replace(/\[1m\]/g, '');
  m = m.replace(/^claude-/, '').replace(/-20\d{6}$/, '');
  const parts = m.split('-').filter(Boolean);
  const famIdx = parts.findIndex((p) => FAMILY_WORDS.includes(p));
  if (famIdx === -1) return raw;
  const fam = parts[famIdx];
  const after = parts.slice(famIdx + 1).filter((p) => /^\d+$/.test(p));
  const before = parts.slice(0, famIdx).filter((p) => /^\d+$/.test(p));
  const version = (after.length ? after : before).join('.');
  let label = version ? `${fam} ${version}` : fam;
  if (parts.includes('fast')) label += ' fast';
  return has1m ? `${label} [1m]` : label;
}
