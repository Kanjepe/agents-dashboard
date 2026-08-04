# Codex provider view — research & design

**Status:** implemented and verified on 2026-08-04. Codex statistics are available through the separate `claude | codex` provider toggle; Claude remains the backward-compatible default.
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

Observed volume during implementation: 15 rollout files. CLI version initially seen: `0.145.0-alpha.30`.

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

## OpenAI pricing (✅ VERIFIED 2026-08-04 — developers.openai.com/api/docs/pricing)

Models observed in local logs: `gpt-5.5` (78×), `gpt-5.4-mini` (18×), `gpt-5.6-sol` (6×).

| Model | Input $/1M | Cached input $/1M | Output $/1M | Long-context (>272K input) |
|---|---|---|---|---|
| gpt-5.6-sol | 5.00 | 0.50 | 30.00 | 10 / 1 / 45 |
| gpt-5.5 | 5.00 | 0.50 | 30.00 | 10 / 1 / 45 |
| gpt-5.4-mini | 0.75 | 0.075 | 4.50 | (no long-context tier) |

Notes: cached input = 0.1× input. No charge for cache writes on OpenAI (`cache_write_input_tokens`
needs no separate rate). `output_tokens` already includes `reasoning_output_tokens` (verified:
input+output = total in samples). Long-context threshold is per request: 272K input tokens.

## Implemented architecture

1. `lib/codex-pricing.js` — OpenAI per-model table, same shape as `lib/pricing.js`
   (familyFor / rateForModel / estimateCostUsd / modelLabel, `estimated` flag for unknowns).
2. `lib/codex.js` — scan `~/.codex/sessions/**/rollout-*.jsonl`, mtime cache like
   `stats.js`, cumulative→delta handling, emit the SAME stats contract:
   `{today, week, month, *Cost, models{...}, last24Hours[], last7Days[], last4Weeks[],
   last6Months[], last12Months[], topToday/Week/Month, pricing, pricingVerifiedAt, fileCount}`
   — `memory` stays absent (Claude-only section, UI hides it).
3. `server.js` — snapshot keeps backward-compatible `stats` for Claude and adds `statsCodex`;
   Codex aggregation failures are isolated so they cannot prevent Claude snapshots.
4. `public/` — provider toggle in the stats panel head; `renderStats()` selects `activeStats()`;
   hide memory-split + observer badges in Codex view.
5. Tests: codex-pricing tests + a fixture rollout file for the delta logic.
6. Live sessions view for Codex remains OUT OF SCOPE v1 (stats only); revisit if needed.

## Open questions

- ~~Does `token_count.info` include `last_token_usage`?~~ ✅ Yes (all 12 files) — use it directly.
- ✅ Exact OpenAI prices for the observed `gpt-5.6-sol`, `gpt-5.5`, and `gpt-5.4-mini` models were verified on 2026-08-04 and recorded above.
- No separate Codex cache TTL tier is present in the observed usage format; cache writes remain unbilled unless the documented format changes.
