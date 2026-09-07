// OpenAI (Codex CLI) per-model pricing in USD per 1,000,000 tokens.
// Verified against developers.openai.com/api/docs/pricing.
// Codex usage semantics differ from Anthropic:
//   - input_tokens INCLUDES cached_input_tokens (split before pricing)
//   - cache writes are free (no cache_write rate)
//   - output_tokens already includes reasoning_output_tokens
//   - long-context premium applies per request above 272K input tokens

export const CODEX_PRICING_VERIFIED_AT = '2026-09-07';

const LONG_CONTEXT_THRESHOLD = 272_000;

const FAMILIES = [
  {
    // GPT-6 charges for cache writes ($12.50/1M short, $25/1M long) — the
    // first OpenAI model to do so — but Codex last_token_usage exposes no
    // cache-write count, so those tokens can't be priced here and estimates
    // may run slightly low on cache-heavy sessions.
    family: 'gpt-6',
    label: 'gpt-6 astra',
    match: (m) => m.includes('gpt-6'),
    input: 10,
    cachedInput: 1,
    output: 50,
    long: { input: 20, cachedInput: 2, output: 75 },
  },
  {
    family: 'gpt-5.6',
    label: 'gpt-5.6 sol',
    match: (m) => m.includes('gpt-5.6'),
    // Base = promo pricing (>20% cut announced 2026-08-21, guaranteed at
    // least through 2026-11-21). If OpenAI restores the launch rates after
    // the promo, add a tier boundary here instead of editing the base.
    input: 4,
    cachedInput: 0.4,
    output: 20,
    long: { input: 8, cachedInput: 0.8, output: 30 },
    // tiers: date-dependent overrides, checked in order; an entry applies
    // when the usage timestamp is strictly before its `until` (YYYY-MM-DD).
    tiers: [
      {
        until: '2026-08-21',
        input: 5,
        cachedInput: 0.5,
        output: 30,
        long: { input: 10, cachedInput: 1, output: 45 },
      },
    ],
  },
  {
    family: 'gpt-5.5',
    label: 'gpt-5.5',
    match: (m) => m.includes('gpt-5.5'),
    input: 5,
    cachedInput: 0.5,
    output: 30,
    long: { input: 10, cachedInput: 1, output: 45 },
  },
  {
    family: 'gpt-5.4-mini',
    label: 'gpt-5.4 mini',
    match: (m) => m.includes('gpt-5.4-mini'),
    input: 0.75,
    cachedInput: 0.075,
    output: 4.5,
    long: null,
  },
];

const DEFAULT_FAMILY = 'gpt-5.5';

function findFamily(model) {
  if (!model) return null;
  const m = String(model).toLowerCase();
  return FAMILIES.find((f) => f.match(m)) || null;
}

export function codexFamilyFor(model) {
  const f = findFamily(model);
  return f ? f.family : null;
}

// Resolves the family's rate set for a usage timestamp: the first tier whose
// `until` is after the usage day wins, otherwise the family's base rates.
function baseRates(f, timestamp) {
  if (f.tiers && timestamp) {
    // Local calendar day, consistent with dayKey() bucketing everywhere else.
    const d = new Date(timestamp);
    const day = Number.isNaN(d.getTime())
      ? String(timestamp).slice(0, 10)
      : d.toLocaleDateString('sv-SE');
    for (const tier of f.tiers) {
      if (day < tier.until) return tier;
    }
  }
  return f;
}

function buildRate(f, longContext, timestamp) {
  const rates = baseRates(f, timestamp);
  const useLong = longContext && rates.long;
  const src = useLong ? rates.long : rates;
  return {
    family: f.family,
    label: useLong ? `${f.label} [long ctx]` : f.label,
    input: src.input,
    cachedInput: src.cachedInput,
    output: src.output,
  };
}

export function codexRateForModel(model, { longContext = false, timestamp = null } = {}) {
  const f = findFamily(model);
  const rate = buildRate(
    f || FAMILIES.find((x) => x.family === DEFAULT_FAMILY),
    longContext,
    timestamp,
  );
  if (!f) rate.estimated = true;
  return rate;
}

export function getCodexPricingTable() {
  const now = new Date().toISOString();
  return FAMILIES.map((f) => buildRate(f, false, now));
}

// input INCLUDES cachedInput (Codex last_token_usage semantics).
// Returns an UNROUNDED figure — round at the aggregation/display boundary.
export function codexEstimateCostUsd({ input = 0, cachedInput = 0, output = 0 }, model, timestamp) {
  const p = codexRateForModel(model, {
    longContext: input > LONG_CONTEXT_THRESHOLD,
    timestamp,
  });
  const uncached = Math.max(0, input - cachedInput);
  return (uncached * p.input + cachedInput * p.cachedInput + output * p.output) / 1_000_000;
}

// OpenAI model ids are already short and readable — pass through.
export function codexModelLabel(model) {
  return model ? String(model) : 'unknown';
}
