import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { decodeProjectDirName, shortProjectName, dayKey, usageBreakdown } from './utils.js';
import {
  estimateCostUsd,
  getPricingTable,
  modelLabel,
  familyFor,
  PRICING_VERIFIED_AT,
} from './pricing.js';

const round2 = (v) => Math.round(v * 100) / 100;
import { isObserverPath } from './sessions.js';

// Re-exported for backward compat (tests import these from this module).
export { dayKey, usageBreakdown };

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

const STATS_CACHE_MS = 60_000;
// Covers the 12-month yearly view (with margin for long-running files).
const STATS_LOOKBACK_DAYS = 400;

const fileTokenCache = new Map();
let aggregateCache = { ts: 0, data: null };

export function startOfWeekKey(d) {
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff);
  return monday.toLocaleDateString('sv-SE');
}

export function startOfMonthKey(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1).toLocaleDateString('sv-SE');
}

function hourBucketKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  return `${y}-${m}-${day}T${h}`;
}

async function parseFileTokens(filePath, fileStats, projectDir) {
  const cached = fileTokenCache.get(filePath);
  if (cached && cached.mtimeMs === fileStats.mtimeMs) {
    return cached;
  }

  let content;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }

  const lines = content.split('\n');
  let projectName = null;
  let isMemory = false;
  const days = new Map();
  const hours = new Map();
  const daysCost = new Map();
  const hoursCost = new Map();
  // day -> model -> { tokens, cost }
  const daysModel = new Map();
  // hour bucket -> model -> { tokens, cost }
  const hoursModel = new Map();

  for (const line of lines) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.cwd && !projectName) {
      projectName = shortProjectName(entry.cwd);
      isMemory = isObserverPath(entry.cwd);
    }
    if (entry.type !== 'assistant' || !entry.message || !entry.timestamp) continue;
    const usage = entry.message.usage;
    if (!usage) continue;

    const u = usageBreakdown(usage);
    const total = u.total;
    const model = entry.message.model || 'unknown';
    const cost = estimateCostUsd(u, model, entry.timestamp);

    const day = dayKey(entry.timestamp);
    days.set(day, (days.get(day) || 0) + total);
    daysCost.set(day, (daysCost.get(day) || 0) + cost);

    let dm = daysModel.get(day);
    if (!dm) {
      dm = new Map();
      daysModel.set(day, dm);
    }
    let mAgg = dm.get(model);
    if (!mAgg) {
      mAgg = { tokens: 0, cost: 0 };
      dm.set(model, mAgg);
    }
    mAgg.tokens += total;
    mAgg.cost += cost;

    const hk = hourBucketKey(entry.timestamp);
    if (hk) {
      hours.set(hk, (hours.get(hk) || 0) + total);
      hoursCost.set(hk, (hoursCost.get(hk) || 0) + cost);

      let hm = hoursModel.get(hk);
      if (!hm) {
        hm = new Map();
        hoursModel.set(hk, hm);
      }
      let hAgg = hm.get(model);
      if (!hAgg) {
        hAgg = { tokens: 0, cost: 0 };
        hm.set(model, hAgg);
      }
      hAgg.tokens += total;
      hAgg.cost += cost;
    }
  }

  if (!projectName) {
    const decoded = decodeProjectDirName(projectDir);
    projectName = shortProjectName(decoded);
    isMemory = isObserverPath(decoded);
  }

  const result = {
    mtimeMs: fileStats.mtimeMs,
    projectName,
    isMemory,
    days,
    hours,
    daysCost,
    hoursCost,
    daysModel,
    hoursModel,
  };
  fileTokenCache.set(filePath, result);
  return result;
}

function emptyStats() {
  const today = new Date();
  return {
    today: 0,
    week: 0,
    month: 0,
    todayCost: 0,
    weekCost: 0,
    monthCost: 0,
    todayDate: today.toLocaleDateString('sv-SE'),
    weekStart: startOfWeekKey(today),
    monthStart: startOfMonthKey(today),
    topToday: [],
    topWeek: [],
    topMonth: [],
    models: { today: [], week: [], month: [] },
    memory: {
      today: { tokens: 0, cost: 0 },
      week: { tokens: 0, cost: 0 },
      month: { tokens: 0, cost: 0 },
    },
    last24Hours: [],
    last7Days: [],
    last4Weeks: [],
    last6Months: [],
    last12Months: [],
    pricing: getPricingTable(),
    pricingVerifiedAt: PRICING_VERIFIED_AT,
    fileCount: 0,
  };
}

export async function aggregateStats() {
  const now = Date.now();
  if (aggregateCache.data && now - aggregateCache.ts < STATS_CACHE_MS) {
    return aggregateCache.data;
  }

  let projectDirs;
  try {
    projectDirs = await readdir(CLAUDE_PROJECTS_DIR);
  } catch {
    return emptyStats();
  }

  const cutoffMs = now - STATS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const candidates = [];

  for (const projectDir of projectDirs) {
    const projectPath = join(CLAUDE_PROJECTS_DIR, projectDir);
    let files;
    try {
      files = await readdir(projectPath);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = join(projectPath, file);
      try {
        const fileStats = await stat(filePath);
        if (fileStats.mtimeMs < cutoffMs) continue;
        candidates.push({ filePath, fileStats, projectDir });
      } catch {
        // skip
      }
    }
  }

  const today = new Date();
  const todayKey = today.toLocaleDateString('sv-SE');
  const weekStart = startOfWeekKey(today);
  const monthStart = startOfMonthKey(today);

  const lookbackStartKey = new Date(now - STATS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    .toLocaleDateString('sv-SE');

  const byProject = new Map();
  const byDay = new Map();
  const byHour = new Map();
  const byDayCost = new Map();
  const byHourCost = new Map();
  // day -> model -> { tokens, cost }
  const byDayModel = new Map();
  // hour bucket -> model -> { tokens, cost }
  const byHourModel = new Map();
  // memory-infra (claude-mem observer) share per day
  const memoryByDay = new Map();

  for (const cand of candidates) {
    const parsed = await parseFileTokens(cand.filePath, cand.fileStats, cand.projectDir);
    if (!parsed) continue;

    const projectName = parsed.projectName;
    let projAgg = byProject.get(projectName);
    if (!projAgg) {
      projAgg = {
        day: 0, week: 0, month: 0,
        dayCost: 0, weekCost: 0, monthCost: 0,
        isMemory: !!parsed.isMemory,
      };
      byProject.set(projectName, projAgg);
    }

    for (const [dayK, total] of parsed.days) {
      if (dayK < lookbackStartKey) continue;

      byDay.set(dayK, (byDay.get(dayK) || 0) + total);
      const dayCost = (parsed.daysCost && parsed.daysCost.get(dayK)) || 0;
      byDayCost.set(dayK, (byDayCost.get(dayK) || 0) + dayCost);

      if (parsed.isMemory) {
        let mem = memoryByDay.get(dayK);
        if (!mem) {
          mem = { tokens: 0, cost: 0 };
          memoryByDay.set(dayK, mem);
        }
        mem.tokens += total;
        mem.cost += dayCost;
      }

      if (dayK >= monthStart) {
        projAgg.month += total;
        projAgg.monthCost += dayCost;
      }
      if (dayK >= weekStart) {
        projAgg.week += total;
        projAgg.weekCost += dayCost;
      }
      if (dayK === todayKey) {
        projAgg.day += total;
        projAgg.dayCost += dayCost;
      }
    }

    if (parsed.daysModel) {
      for (const [dayK, models] of parsed.daysModel) {
        if (dayK < lookbackStartKey) continue;
        let dm = byDayModel.get(dayK);
        if (!dm) {
          dm = new Map();
          byDayModel.set(dayK, dm);
        }
        for (const [model, agg] of models) {
          let mAgg = dm.get(model);
          if (!mAgg) {
            mAgg = { tokens: 0, cost: 0 };
            dm.set(model, mAgg);
          }
          mAgg.tokens += agg.tokens;
          mAgg.cost += agg.cost;
        }
      }
    }

    if (parsed.hours) {
      for (const [hk, total] of parsed.hours) {
        byHour.set(hk, (byHour.get(hk) || 0) + total);
        const hCost = (parsed.hoursCost && parsed.hoursCost.get(hk)) || 0;
        byHourCost.set(hk, (byHourCost.get(hk) || 0) + hCost);
      }
    }

    if (parsed.hoursModel) {
      for (const [hk, models] of parsed.hoursModel) {
        let hm = byHourModel.get(hk);
        if (!hm) {
          hm = new Map();
          byHourModel.set(hk, hm);
        }
        for (const [model, agg] of models) {
          let mAgg = hm.get(model);
          if (!mAgg) {
            mAgg = { tokens: 0, cost: 0 };
            hm.set(model, mAgg);
          }
          mAgg.tokens += agg.tokens;
          mAgg.cost += agg.cost;
        }
      }
    }
  }

  const data = buildStatsData(
    { byProject, byDay, byHour, byDayCost, byHourCost, byDayModel, byHourModel, memoryByDay },
    {
      fileCount: candidates.length,
      pricing: getPricingTable(),
      pricingVerifiedAt: PRICING_VERIFIED_AT,
      labelFor: modelLabel,
      familyFor,
    },
  );

  aggregateCache = { ts: now, data };
  return data;
}

// Provider-agnostic stats assembly: turns the bucket maps into the dashboard
// data contract. Used by the Claude aggregation above and the Codex adapter
// (lib/codex.js) so both providers emit an identical shape.
export function buildStatsData(
  { byProject, byDay, byHour, byDayCost, byHourCost, byDayModel, byHourModel, memoryByDay = new Map() },
  { fileCount = 0, pricing = [], pricingVerifiedAt = null, labelFor = (m) => String(m), familyFor: famFor = () => 'known' },
) {
  const today = new Date();
  const todayKey = today.toLocaleDateString('sv-SE');
  const weekStart = startOfWeekKey(today);
  const monthStart = startOfMonthKey(today);

  let todayTotal = 0;
  let weekTotal = 0;
  let monthTotal = 0;
  let todayCost = 0;
  let weekCost = 0;
  let monthCost = 0;
  for (const [dk, t] of byDay) {
    const c = byDayCost.get(dk) || 0;
    if (dk >= monthStart) {
      monthTotal += t;
      monthCost += c;
    }
    if (dk >= weekStart) {
      weekTotal += t;
      weekCost += c;
    }
    if (dk === todayKey) {
      todayTotal += t;
      todayCost += c;
    }
  }

  const topBy = (key, costKey, limit = 8) =>
    Array.from(byProject.entries())
      .map(([name, t]) => ({
        name,
        tokens: t[key],
        cost: round2(t[costKey] || 0),
        isMemory: !!t.isMemory,
      }))
      .filter((p) => p.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, limit);

  // model -> {tokens, cost} map into a sorted display array
  const toModelArray = (acc) =>
    Array.from(acc.entries())
      .map(([model, agg]) => ({
        model,
        label: labelFor(model),
        tokens: agg.tokens,
        cost: round2(agg.cost),
        // unknown model → priced at provider default rates, mark as estimate
        estimated: famFor(model) === null || undefined,
      }))
      .filter((m) => m.tokens > 0)
      .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);

  // Sum per-model usage over a day-key range ([fromKey, toKey); toKey null = open)
  const modelsBetween = (fromKey, toKey) => {
    const acc = new Map();
    for (const [dayK, models] of byDayModel) {
      if (dayK < fromKey) continue;
      if (toKey && dayK >= toKey) continue;
      for (const [model, agg] of models) {
        let mAgg = acc.get(model);
        if (!mAgg) {
          mAgg = { tokens: 0, cost: 0 };
          acc.set(model, mAgg);
        }
        mAgg.tokens += agg.tokens;
        mAgg.cost += agg.cost;
      }
    }
    return toModelArray(acc);
  };

  const memoryBetween = (fromKey, toKey) => {
    let tokens = 0;
    let cost = 0;
    for (const [dayK, mem] of memoryByDay) {
      if (dayK < fromKey) continue;
      if (toKey && dayK >= toKey) continue;
      tokens += mem.tokens;
      cost += mem.cost;
    }
    return { tokens, cost: round2(cost) };
  };

  const nextDayKey = (key) => {
    const d = new Date(`${key}T00:00:00`);
    d.setDate(d.getDate() + 1);
    return d.toLocaleDateString('sv-SE');
  };

  const currentHourStart = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
    today.getHours(),
  );
  const last24Hours = [];
  for (let i = 23; i >= 0; i--) {
    const d = new Date(currentHourStart);
    d.setHours(d.getHours() - i);
    const key = hourBucketKey(d.toISOString());
    last24Hours.push({
      hour: d.getHours(),
      day: d.getDay(),
      tokens: byHour.get(key) || 0,
      cost: round2(byHourCost.get(key) || 0),
      models: toModelArray(byHourModel.get(key) || new Map()),
      isCurrent: i === 0,
    });
  }

  const last7Days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toLocaleDateString('sv-SE');
    last7Days.push({
      date: key,
      tokens: byDay.get(key) || 0,
      cost: round2(byDayCost.get(key) || 0),
      models: modelsBetween(key, nextDayKey(key)),
      isCurrent: i === 0,
    });
  }

  const last4Weeks = [];
  for (let i = 3; i >= 0; i--) {
    const ref = new Date(today);
    ref.setDate(ref.getDate() - i * 7);
    const wkStart = startOfWeekKey(ref);
    let tokens = 0;
    let cost = 0;
    for (const [dk, t] of byDay) {
      if (dk >= wkStart) {
        const wk = startOfWeekKey(new Date(`${dk}T00:00:00`));
        if (wk === wkStart) {
          tokens += t;
          cost += byDayCost.get(dk) || 0;
        }
      }
    }
    const wkEnd = new Date(`${wkStart}T00:00:00`);
    wkEnd.setDate(wkEnd.getDate() + 7);
    last4Weeks.push({
      weekStart: wkStart,
      tokens,
      cost: round2(cost),
      models: modelsBetween(wkStart, wkEnd.toLocaleDateString('sv-SE')),
      isCurrent: i === 0,
    });
  }

  const buildMonths = (count) => {
    const out = [];
    for (let i = count - 1; i >= 0; i--) {
      const ref = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const monthStartKey = ref.toLocaleDateString('sv-SE');
      const nextMonthStart = new Date(ref.getFullYear(), ref.getMonth() + 1, 1)
        .toLocaleDateString('sv-SE');
      let tokens = 0;
      let cost = 0;
      for (const [dk, t] of byDay) {
        if (dk >= monthStartKey && dk < nextMonthStart) {
          tokens += t;
          cost += byDayCost.get(dk) || 0;
        }
      }
      out.push({
        monthStart: monthStartKey,
        month: ref.getMonth(),
        year: ref.getFullYear(),
        tokens,
        cost: round2(cost),
        models: modelsBetween(monthStartKey, nextMonthStart),
        isCurrent: i === 0,
      });
    }
    return out;
  };

  const last12Months = buildMonths(12);
  const last6Months = last12Months.slice(6);

  return {
    today: todayTotal,
    week: weekTotal,
    month: monthTotal,
    todayCost: round2(todayCost),
    weekCost: round2(weekCost),
    monthCost: round2(monthCost),
    todayDate: todayKey,
    weekStart,
    monthStart,
    topToday: topBy('day', 'dayCost'),
    topWeek: topBy('week', 'weekCost'),
    topMonth: topBy('month', 'monthCost'),
    models: {
      today: modelsBetween(todayKey, nextDayKey(todayKey)),
      week: modelsBetween(weekStart, null),
      month: modelsBetween(monthStart, null),
    },
    memory: {
      today: memoryBetween(todayKey, nextDayKey(todayKey)),
      week: memoryBetween(weekStart, null),
      month: memoryBetween(monthStart, null),
    },
    last24Hours,
    last7Days,
    last4Weeks,
    last6Months,
    last12Months,
    pricing,
    pricingVerifiedAt,
    fileCount,
  };
}

export function invalidateStatsCache() {
  aggregateCache = { ts: 0, data: null };
}
