# Codex provider view — research & design

**Status:** researched + design agreed, not yet implemented.
**Decision (2026-08-04):** separate provider views with a `claude | codex` toggle in the stats panel — NOT a merged single view. Render functions are reused 1:1 because the Codex adapter must emit the exact same `stats` data contract as `aggregateStats()`. A combined "both" button (totals-only) may come later.

## Why separate views

- Token semantics differ (Codex has reasoning tokens; cache mechanics differ) — merged tables mislead.
- Memory/observer section is Claude-specific (claude-mem) — hidden in the Codex view.
- A Codex adapter bug can never break the Claude view.
- Model visibility inside each view is already covered by the "by model" sections.

## Codex CLI local data (verified on this machine, 2026-08-04)

Everything is local and read-only — same approach as Claude JSONL scanning. No API keys needed.

| What | Where |
|---|---|
| Session logs | `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl` |
| Prompt history | `~/.codex/history.jsonl` |
| Other (not needed) | `~/.codex/logs_2.sqlite`, `goals_1.sqlite`, `memories_1.sqlite`, `config.toml` |

Observed volume: 12 rollout files (2026-04-29 … 2026-07-28). CLI version seen: `0.145.0-alpha.30`.

## Rollout JSONL format (observed sample)

Each line: `{"timestamp": "...", "type": "<entry type>", "payload": {...}}`.

Entry types seen (one small session): `session_meta` (1), `turn_context` (2), `event_msg` (11), `response_item` (9), `token_count` (2), `task_started`/`task_complete` (2 each), `user_message`, `agent_message`, `reasoning`, etc.

### `session_meta` (first line) — session identity

```json
{"timestamp":"2026-07-28T13:04:30.343Z","type":"session_meta","payload":{
  "session_id":"019fa8d3-...","cwd":"C:\\Users\\Egils.Varna\\Projects",
  "originator":"codex-tui","cli_version":"0.145.0-alpha.30","source":"cli",
  "model_provider":"openai","base_instructions":{...}}}
```

→ `cwd` gives the project name (same `shortProjectName()` logic as Claude).

### `token_count` — usage accounting (CUMULATIVE!)

```json
{"type":"token_count","info":{"total_token_usage":{
  "input_tokens":40143,"cached_input_tokens":19200,"cache_write_input_tokens":0,
  "output_tokens":478,"reasoning_output_tokens":20,"total_tokens":40621}}}
```

⚠️ **`total_token_usage` is a running total for the session, not a per-message delta.**
✅ RESOLVED: `info` also carries **`last_token_usage`** (per-turn usage) — verified present in
all 12 rollout files on this machine. Use `last_token_usage` directly per `token_count` event
(with the event's own `timestamp` for hour/day bucketing); no delta arithmetic needed.

```json
"last_token_usage":{"input_tokens":20096,"cached_input_tokens":19200,
  "cache_write_input_tokens":0,"output_tokens":452,
  "reasoning_output_tokens":20,"total_tokens":20548}
```

Field mapping to our pipeline:

| Codex field | Our field |
|---|---|
| `input_tokens` | input (⚠️ verify: may already include `cached_input_tokens` — check whether input+cached+output ≈ total_tokens or input already contains cached) |
| `cached_input_tokens` | cacheRead |
| `cache_write_input_tokens` | cacheCreate |
| `output_tokens` | output (⚠️ verify whether it includes `reasoning_output_tokens`) |
| `reasoning_output_tokens` | billed as output on OpenAI — track separately for display |

Observed sample sanity: `20047+0+0+26=20073=total` → in that sample `input_tokens` did NOT
double-count cache (cached was 0); second sample `40143+478=40621=total` while cached=19200 →
**`input_tokens` INCLUDES `cached_input_tokens`** (40143 input incl. 19200 cached). Pricing must
therefore split: uncached input = `input_tokens - cached_input_tokens`.

### Model

Model appears in `turn_context` / response payloads: `"model":"gpt-5.6-sol"` (observed).
One session can in principle switch models per turn — capture per `turn_context`.

## OpenAI pricing (TO VERIFY at implementation time — do not trust from memory)

Look up current rates at https://platform.openai.com/docs/pricing for the observed model IDs
(gpt-5.x family incl. `gpt-5.6-sol`). Needed per model: input $/1M, cached-input $/1M,
output $/1M. Add `PRICING_VERIFIED_AT` for the OpenAI table too, same staleness rule as
Anthropic. Reasoning tokens bill as output tokens.

## Implementation plan (when we build it)

1. `lib/codex-pricing.js` — OpenAI per-model table, same shape as `lib/pricing.js`
   (familyFor / rateForModel / estimateCostUsd / modelLabel, `estimated` flag for unknowns).
2. `lib/codex.js` — scan `~/.codex/sessions/**/rollout-*.jsonl`, mtime cache like
   `stats.js`, cumulative→delta handling, emit the SAME stats contract:
   `{today, week, month, *Cost, models{...}, last24Hours[], last7Days[], last4Weeks[],
   last6Months[], last12Months[], topToday/Week/Month, pricing, pricingVerifiedAt, fileCount}`
   — `memory` stays absent (Claude-only section, UI hides it).
3. `server.js` — snapshot gains `stats: {claude, codex}` (or `statsCodex` alongside; pick
   whichever keeps the WS payload backward-compatible).
4. `public/` — provider toggle in the stats panel head; `renderStats(currentProviderStats)`;
   hide memory-split + observer badges in Codex view.
5. Tests: codex-pricing tests + a fixture rollout file for the delta logic.
6. Live sessions view for Codex: OUT OF SCOPE v1 (stats only); revisit if needed.

## Open questions

- ~~Does `token_count.info` include `last_token_usage`?~~ ✅ Yes (all 12 files) — use it directly.
- Exact current OpenAI prices for `gpt-5.6-sol` (and other gpt-5.x variants in the logs).
- Does Codex have a cache TTL split like Anthropic 5m/1h? (assume no until documented)
