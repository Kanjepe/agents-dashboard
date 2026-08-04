# Model cost breakdown rebuild

**Goal:** Accurate per-model token/cost reporting (daily/weekly/monthly, retrospective) with current Anthropic pricing, plus separate accounting for claude-mem observer (memory) sessions.

## Why

1. `lib/pricing.js` is stale: Opus 4.6+ billed at $15/$75 (real: $5/$25), Fable 5 missing entirely (falls back to Sonnet rates). 30-day usage is ~2.3B tokens, mostly Fable 5 — current cost reports are badly wrong.
2. No per-model dimension in `lib/stats.js` — model ID is present in every JSONL usage entry but unused.
3. Observer sessions (`~/.claude-mem/observer-sessions`) are counted as a regular project (~14% of tokens, 100% Haiku). They should be visible as a separate "memory infra" category.

## Architecture

All changes are in the existing read-only aggregation pipeline: `stats.js` parse → aggregate → `/api/sessions` snapshot → `public/app.js` render. No new endpoints, no schema migration (JSONL is the source of truth; retrospective data works immediately).

## Tasks

### 1. `lib/pricing.js` — per-model-ID pricing (with tests first)

Ordered match rules (first hit wins), USD per 1M tokens:

| key | matches | input | output | notes |
|---|---|---|---|---|
| `fable-5` | fable, mythos | 10 | 50 | |
| `opus-modern` | opus-5, opus-4-5..4-8 | 5 | 25 | 1M ctx standard price on 4.7+ |
| `opus-legacy` | any other opus | 15 | 75 | 4.1 and older |
| `sonnet-5` | sonnet-5 | 3 / intro 2 | 15 / intro 10 | intro until 2026-09-01 (date-tiered) |
| `sonnet` | other sonnet | 3 | 15 | |
| `haiku-3.5` | haiku-3-5 / 3.5 | 0.8 | 4 | |
| `haiku` | other haiku | 1 | 5 | |

Cache rates derived: read = 0.1×input; write 5m = 1.25×input; write 1h = 2×input.
`[1m]` long-context premium (input ×2, output ×1.5) applies only to sonnet ≤4.6 and opus ≤4.6 (4.7+/5/Fable have standard 1M pricing).
`estimateCostUsd({input, output, cacheRead, cacheCreate5m, cacheCreate1h}, model, timestamp)` — timestamp only affects date-tiered entries (Sonnet 5 intro). Backward-compat `cacheCreate` treated as 5m.

### 2. `lib/stats.js` — byModel + memory split

- `parseFileTokens`: also accumulate `daysModel: Map<day, Map<model, {tokens, cost}>>`; detect `isMemory` (cwd contains `.claude-mem`); use `usage.cache_creation.ephemeral_5m/1h_input_tokens` split when present.
- `aggregateStats` additions to the returned data:
  - `models: {today: [], week: [], month: []}` — `{model, label, tokens, cost}` sorted by cost desc
  - `last7Days` / `last4Weeks` / `last6Months` entries get `models: [...]` breakdown
  - `memory: {today, week, month, todayCost, weekCost, monthCost}` — observer-session share
  - top-project entries get `isMemory` flag

### 3. UI (`public/index.html`, `app.js`, `style.css`)

- New "by model" panel in stats view: today/week/month lists (reuse `renderTop` pattern) with model label, tokens, cost.
- Per-month history table: month × model breakdown (last 6 months).
- Memory split line under totals: work vs memory tokens/cost; observer row marked in top-projects.
- Update client `PRICING_FALLBACK` + `familyForModel` to mirror the new server rules; pricing-ref table renders new rows.

### 4. Verification

- `npm test` green (new `tests/pricing.test.js`, extended stats tests).
- Live server: `/api/sessions` snapshot contains `stats.models` and `stats.memory`; sanity-check against ad-hoc 30-day aggregation (2.3B tokens; observer ~14%).

## Out of scope

- Historical price changes within the same model ID (we use each model's launch-era price; only Sonnet 5 intro tier is date-aware).
- Per-session model breakdown UI (session cards already show model tooltip).
