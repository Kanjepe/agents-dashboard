// OpenAI (Codex CLI) per-model pricing in USD per 1,000,000 tokens.
// Verified against developers.openai.com/api/docs/pricing.
// Codex usage semantics differ from Anthropic:
//   - input_tokens INCLUDES cached_input_tokens (split before pricing)
//   - cache writes are free (no cache_write rate)
//   - output_tokens already includes reasoning_output_tokens
//   - long-context premium applies per request above 272K input tokens

export const CODEX_PRICING_VERIFIED_AT = '2026-08-04';

const LONG_CONTEXT_THRESHOLD = 272_000;

const FAMILIES = [
  {
    family: 'gpt-5.6',
    label: 'gpt-5.6 sol',
    match: (m) => m.includes('gpt-5.6'),
    input: 5,
    cachedInput: 0.5,
    output: 30,
    long: { input: 10, cachedInput: 1, output: 45 },
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

function buildRate(f, longContext) {
  const useLong = longContext && f.long;
  const src = useLong ? f.long : f;
  return {
    family: f.family,
    label: useLong ? `${f.label} [long ctx]` : f.label,
    input: src.input,
    cachedInput: src.cachedInput,
    output: src.output,
  };
}

export function codexRateForModel(model, { longContext = false } = {}) {
  const f = findFamily(model);
  const rate = buildRate(f || FAMILIES.find((x) => x.family === DEFAULT_FAMILY), longContext);
  if (!f) rate.estimated = true;
  return rate;
}

export function getCodexPricingTable() {
  return FAMILIES.map((f) => buildRate(f, false));
}

// input INCLUDES cachedInput (Codex last_token_usage semantics).
// Returns an UNROUNDED figure — round at the aggregation/display boundary.
export function codexEstimateCostUsd({ input = 0, cachedInput = 0, output = 0 }, model) {
  const p = codexRateForModel(model, { longContext: input > LONG_CONTEXT_THRESHOLD });
  const uncached = Math.max(0, input - cachedInput);
  return (uncached * p.input + cachedInput * p.cachedInput + output * p.output) / 1_000_000;
}

// OpenAI model ids are already short and readable — pass through.
export function codexModelLabel(model) {
  return model ? String(model) : 'unknown';
}
