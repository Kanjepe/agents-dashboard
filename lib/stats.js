import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { decodeProjectDirName, shortProjectName, dayKey } from './utils.js';
import { estimateCostUsd } from './pricing.js';

// Re-exported for backward compat (tests/stats.test.js imports dayKey
// from this module).
export { dayKey };

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

const STATS_CACHE_MS = 60_000;
const STATS_LOOKBACK_DAYS = 200;

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
  const days = new Map();
  const hours = new Map();
  const daysCost = new Map();
  const hoursCost = new Map();

  for (const line of lines) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.cwd && !projectName) projectName = shortProjectName(entry.cwd);
    if (entry.type !== 'assistant' || !entry.message || !entry.timestamp) continue;
    const usage = entry.message.usage;
    if (!usage) continue;

    const inTok = usage.input_tokens || 0;
    const outTok = usage.output_tokens || 0;
    const cRead = usage.cache_read_input_tokens || 0;
    const cCreate = usage.cache_creation_input_tokens || 0;
    const total = inTok + outTok + cRead + cCreate;
    const cost = estimateCostUsd(
      { input: inTok, output: outTok, cacheRead: cRead, cacheCreate: cCreate },
      entry.message.model,
    );

    const day = dayKey(entry.timestamp);
    days.set(day, (days.get(day) || 0) + total);
    daysCost.set(day, (daysCost.get(day) || 0) + cost);

    const hk = hourBucketKey(entry.timestamp);
    if (hk) {
      hours.set(hk, (hours.get(hk) || 0) + total);
      hoursCost.set(hk, (hoursCost.get(hk) || 0) + cost);
    }
  }

  if (!projectName) projectName = shortProjectName(decodeProjectDirName(projectDir));

  const result = {
    mtimeMs: fileStats.mtimeMs,
    projectName,
    days,
    hours,
    daysCost,
    hoursCost,
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
    last24Hours: [],
    last7Days: [],
    last4Weeks: [],
    last6Months: [],
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

  let todayTotal = 0;
  let weekTotal = 0;
  let monthTotal = 0;
  let todayCost = 0;
  let weekCost = 0;
  let monthCost = 0;
  const byProject = new Map();
  const byDay = new Map();
  const byHour = new Map();
  const byDayCost = new Map();
  const byHourCost = new Map();

  for (const cand of candidates) {
    const parsed = await parseFileTokens(cand.filePath, cand.fileStats, cand.projectDir);
    if (!parsed) continue;

    const projectName = parsed.projectName;
    let projAgg = byProject.get(projectName);
    if (!projAgg) {
      projAgg = {
        day: 0, week: 0, month: 0,
        dayCost: 0, weekCost: 0, monthCost: 0,
      };
      byProject.set(projectName, projAgg);
    }

    for (const [dayK, total] of parsed.days) {
      if (dayK < lookbackStartKey) continue;

      byDay.set(dayK, (byDay.get(dayK) || 0) + total);
      const dayCost = (parsed.daysCost && parsed.daysCost.get(dayK)) || 0;
      byDayCost.set(dayK, (byDayCost.get(dayK) || 0) + dayCost);

      if (dayK >= monthStart) {
        monthTotal += total;
        projAgg.month += total;
        monthCost += dayCost;
        projAgg.monthCost += dayCost;
      }
      if (dayK >= weekStart) {
        weekTotal += total;
        projAgg.week += total;
        weekCost += dayCost;
        projAgg.weekCost += dayCost;
      }
      if (dayK === todayKey) {
        todayTotal += total;
        projAgg.day += total;
        todayCost += dayCost;
        projAgg.dayCost += dayCost;
      }
    }

    if (parsed.hours) {
      for (const [hk, total] of parsed.hours) {
        byHour.set(hk, (byHour.get(hk) || 0) + total);
        const hCost = (parsed.hoursCost && parsed.hoursCost.get(hk)) || 0;
        byHourCost.set(hk, (byHourCost.get(hk) || 0) + hCost);
      }
    }
  }

  const topBy = (key, costKey, limit = 8) =>
    Array.from(byProject.entries())
      .map(([name, t]) => ({ name, tokens: t[key], cost: t[costKey] || 0 }))
      .filter((p) => p.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, limit);

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
      cost: byHourCost.get(key) || 0,
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
      cost: byDayCost.get(key) || 0,
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
    last4Weeks.push({ weekStart: wkStart, tokens, cost, isCurrent: i === 0 });
  }

  const last6Months = [];
  for (let i = 5; i >= 0; i--) {
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
    last6Months.push({
      monthStart: monthStartKey,
      month: ref.getMonth(),
      year: ref.getFullYear(),
      tokens,
      cost,
      isCurrent: i === 0,
    });
  }

  const data = {
    today: todayTotal,
    week: weekTotal,
    month: monthTotal,
    todayCost,
    weekCost,
    monthCost,
    todayDate: todayKey,
    weekStart,
    monthStart,
    topToday: topBy('day', 'dayCost'),
    topWeek: topBy('week', 'weekCost'),
    topMonth: topBy('month', 'monthCost'),
    last24Hours,
    last7Days,
    last4Weeks,
    last6Months,
    fileCount: candidates.length,
  };

  aggregateCache = { ts: now, data };
  return data;
}

export function invalidateStatsCache() {
  aggregateCache = { ts: 0, data: null };
}
