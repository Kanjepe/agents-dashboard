// Codex (OpenAI) CLI session telemetry adapter.
// Reads ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl and emits the SAME stats
// data contract as aggregateStats() (see buildStatsData in stats.js), so the
// dashboard renders both providers with identical code.
// Format notes: docs/plans/2026-08-04-codex-provider-design.md

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { shortProjectName, dayKey } from './utils.js';
import { buildStatsData, startOfWeekKey, startOfMonthKey } from './stats.js';
import {
  codexEstimateCostUsd,
  getCodexPricingTable,
  codexModelLabel,
  codexFamilyFor,
  CODEX_PRICING_VERIFIED_AT,
} from './codex-pricing.js';

const CODEX_SESSIONS_DIR = join(homedir(), '.codex', 'sessions');

const STATS_CACHE_MS = 60_000;
const STATS_LOOKBACK_DAYS = 400;

const fileCache = new Map();
let aggregateCache = { ts: 0, data: null };

function hourBucketKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  return `${y}-${m}-${day}T${h}`;
}

// Pure parser for one rollout file. Exported for tests.
// last_token_usage is the per-turn figure; input_tokens INCLUDES
// cached_input_tokens (see design doc) — pricing splits them.
export function parseRolloutContent(content) {
  let projectName = null;
  let model = 'unknown';
  const events = [];

  for (const line of String(content || '').split('\n')) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === 'session_meta' && entry.payload?.cwd && !projectName) {
      projectName = shortProjectName(entry.payload.cwd);
    }
    if (entry.type === 'turn_context' && entry.payload?.model) {
      model = entry.payload.model;
    }
    if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
      const u = entry.payload.info?.last_token_usage;
      if (!u || !entry.timestamp) continue;
      const input = u.input_tokens || 0;
      const cachedInput = u.cached_input_tokens || 0;
      const output = u.output_tokens || 0;
      events.push({
        timestamp: entry.timestamp,
        model,
        usage: {
          input,
          cachedInput,
          output,
          total: u.total_tokens || input + output,
        },
      });
    }
  }

  return { projectName: projectName || 'unknown', events };
}

async function parseFile(filePath, fileStats) {
  const cached = fileCache.get(filePath);
  if (cached && cached.mtimeMs === fileStats.mtimeMs) return cached;

  let content;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }

  const { projectName, events } = parseRolloutContent(content);

  const days = new Map();
  const daysCost = new Map();
  const daysModel = new Map();
  const hours = new Map();
  const hoursCost = new Map();
  const hoursModel = new Map();

  const bump = (map, key, tokens, cost) => {
    let m = map.get(key);
    if (!m) {
      m = new Map();
      map.set(key, m);
    }
    let agg = m.get(tokens.model);
    if (!agg) {
      agg = { tokens: 0, cost: 0 };
      m.set(tokens.model, agg);
    }
    agg.tokens += tokens.total;
    agg.cost += cost;
  };

  for (const ev of events) {
    const cost = codexEstimateCostUsd(ev.usage, ev.model);
    const total = ev.usage.total;

    const day = dayKey(ev.timestamp);
    days.set(day, (days.get(day) || 0) + total);
    daysCost.set(day, (daysCost.get(day) || 0) + cost);
    bump(daysModel, day, { model: ev.model, total }, cost);

    const hk = hourBucketKey(ev.timestamp);
    if (hk) {
      hours.set(hk, (hours.get(hk) || 0) + total);
      hoursCost.set(hk, (hoursCost.get(hk) || 0) + cost);
      bump(hoursModel, hk, { model: ev.model, total }, cost);
    }
  }

  const result = {
    mtimeMs: fileStats.mtimeMs,
    projectName,
    days,
    daysCost,
    daysModel,
    hours,
    hoursCost,
    hoursModel,
  };
  fileCache.set(filePath, result);
  return result;
}

export function getCodexSessionsDir() {
  return CODEX_SESSIONS_DIR;
}

export async function aggregateCodexStats() {
  const now = Date.now();
  if (aggregateCache.data && now - aggregateCache.ts < STATS_CACHE_MS) {
    return aggregateCache.data;
  }

  // sessions/YYYY/MM/DD/rollout-*.jsonl
  let entries;
  try {
    entries = await readdir(CODEX_SESSIONS_DIR, { recursive: true });
  } catch {
    return emptyCodexStats();
  }

  const cutoffMs = now - STATS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const candidates = [];
  for (const rel of entries) {
    if (!String(rel).endsWith('.jsonl')) continue;
    const filePath = join(CODEX_SESSIONS_DIR, String(rel));
    try {
      const fileStats = await stat(filePath);
      if (fileStats.mtimeMs < cutoffMs) continue;
      candidates.push({ filePath, fileStats });
    } catch {
      // skip
    }
  }

  const today = new Date();
  const todayKey = today.toLocaleDateString('sv-SE');
  const weekStartKey = startOfWeekKey(today);
  const monthStartKey = startOfMonthKey(today);
  const lookbackStartKey = new Date(now - STATS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    .toLocaleDateString('sv-SE');

  const byProject = new Map();
  const byDay = new Map();
  const byDayCost = new Map();
  const byDayModel = new Map();
  const byHour = new Map();
  const byHourCost = new Map();
  const byHourModel = new Map();

  for (const cand of candidates) {
    const parsed = await parseFile(cand.filePath, cand.fileStats);
    if (!parsed) continue;

    let projAgg = byProject.get(parsed.projectName);
    if (!projAgg) {
      projAgg = {
        day: 0, week: 0, month: 0,
        dayCost: 0, weekCost: 0, monthCost: 0,
        isMemory: false,
      };
      byProject.set(parsed.projectName, projAgg);
    }

    for (const [dayK, total] of parsed.days) {
      if (dayK < lookbackStartKey) continue;
      byDay.set(dayK, (byDay.get(dayK) || 0) + total);
      const dayCost = parsed.daysCost.get(dayK) || 0;
      byDayCost.set(dayK, (byDayCost.get(dayK) || 0) + dayCost);

      if (dayK >= monthStartKey) {
        projAgg.month += total;
        projAgg.monthCost += dayCost;
      }
      if (dayK >= weekStartKey) {
        projAgg.week += total;
        projAgg.weekCost += dayCost;
      }
      if (dayK === todayKey) {
        projAgg.day += total;
        projAgg.dayCost += dayCost;
      }
    }

    const mergeModelMap = (target, source, keyFilter) => {
      for (const [key, models] of source) {
        if (keyFilter && !keyFilter(key)) continue;
        let tm = target.get(key);
        if (!tm) {
          tm = new Map();
          target.set(key, tm);
        }
        for (const [model, agg] of models) {
          let mAgg = tm.get(model);
          if (!mAgg) {
            mAgg = { tokens: 0, cost: 0 };
            tm.set(model, mAgg);
          }
          mAgg.tokens += agg.tokens;
          mAgg.cost += agg.cost;
        }
      }
    };
    mergeModelMap(byDayModel, parsed.daysModel, (k) => k >= lookbackStartKey);
    mergeModelMap(byHourModel, parsed.hoursModel, null);

    for (const [hk, total] of parsed.hours) {
      byHour.set(hk, (byHour.get(hk) || 0) + total);
      byHourCost.set(hk, (byHourCost.get(hk) || 0) + (parsed.hoursCost.get(hk) || 0));
    }
  }

  const data = buildStatsData(
    { byProject, byDay, byHour, byDayCost, byHourCost, byDayModel, byHourModel },
    {
      fileCount: candidates.length,
      pricing: getCodexPricingTable(),
      pricingVerifiedAt: CODEX_PRICING_VERIFIED_AT,
      labelFor: codexModelLabel,
      familyFor: codexFamilyFor,
    },
  );

  aggregateCache = { ts: now, data };
  return data;
}

function emptyCodexStats() {
  return buildStatsData(
    {
      byProject: new Map(),
      byDay: new Map(),
      byHour: new Map(),
      byDayCost: new Map(),
      byHourCost: new Map(),
      byDayModel: new Map(),
      byHourModel: new Map(),
    },
    {
      fileCount: 0,
      pricing: getCodexPricingTable(),
      pricingVerifiedAt: CODEX_PRICING_VERIFIED_AT,
      labelFor: codexModelLabel,
      familyFor: codexFamilyFor,
    },
  );
}

export function invalidateCodexStatsCache() {
  aggregateCache = { ts: 0, data: null };
}
