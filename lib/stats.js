import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

const STATS_CACHE_MS = 60_000;
const STATS_LOOKBACK_DAYS = 35;

const fileTokenCache = new Map();
let aggregateCache = { ts: 0, data: null };

function decodeProjectDirName(dirName) {
  if (/^[a-z]--/i.test(dirName)) {
    const drive = dirName[0].toUpperCase();
    const rest = dirName.slice(3).replace(/-/g, '\\');
    return `${drive}:\\${rest}`;
  }
  return dirName.replace(/-/g, '/');
}

function shortProjectName(p) {
  if (!p) return 'unknown';
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || 'unknown';
}

function dayKey(isoTimestamp) {
  return new Date(isoTimestamp).toLocaleDateString('sv-SE');
}

function startOfWeekKey(d) {
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff);
  return monday.toLocaleDateString('sv-SE');
}

function startOfMonthKey(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1).toLocaleDateString('sv-SE');
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

    const day = dayKey(entry.timestamp);
    let b = days.get(day);
    if (!b) {
      b = 0;
      days.set(day, b);
    }
    const total =
      (usage.input_tokens || 0) +
      (usage.output_tokens || 0) +
      (usage.cache_read_input_tokens || 0) +
      (usage.cache_creation_input_tokens || 0);
    days.set(day, b + total);
  }

  if (!projectName) projectName = shortProjectName(decodeProjectDirName(projectDir));

  const result = { mtimeMs: fileStats.mtimeMs, projectName, days };
  fileTokenCache.set(filePath, result);
  return result;
}

function emptyStats() {
  const today = new Date();
  return {
    today: 0,
    week: 0,
    month: 0,
    todayDate: today.toLocaleDateString('sv-SE'),
    weekStart: startOfWeekKey(today),
    monthStart: startOfMonthKey(today),
    topToday: [],
    topWeek: [],
    topMonth: [],
    last7Days: [],
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

  let todayTotal = 0;
  let weekTotal = 0;
  let monthTotal = 0;
  const byProject = new Map();
  const byDay = new Map();

  for (const cand of candidates) {
    const parsed = await parseFileTokens(cand.filePath, cand.fileStats, cand.projectDir);
    if (!parsed) continue;

    const projectName = parsed.projectName;
    let projAgg = byProject.get(projectName);
    if (!projAgg) {
      projAgg = { day: 0, week: 0, month: 0 };
      byProject.set(projectName, projAgg);
    }

    for (const [dayK, total] of parsed.days) {
      if (dayK < monthStart) continue;

      monthTotal += total;
      projAgg.month += total;
      byDay.set(dayK, (byDay.get(dayK) || 0) + total);

      if (dayK >= weekStart) {
        weekTotal += total;
        projAgg.week += total;
      }
      if (dayK === todayKey) {
        todayTotal += total;
        projAgg.day += total;
      }
    }
  }

  const topBy = (key, limit = 8) =>
    Array.from(byProject.entries())
      .map(([name, t]) => ({ name, tokens: t[key] }))
      .filter((p) => p.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, limit);

  const last7Days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toLocaleDateString('sv-SE');
    last7Days.push({ date: key, tokens: byDay.get(key) || 0 });
  }

  const data = {
    today: todayTotal,
    week: weekTotal,
    month: monthTotal,
    todayDate: todayKey,
    weekStart,
    monthStart,
    topToday: topBy('day'),
    topWeek: topBy('week'),
    topMonth: topBy('month'),
    last7Days,
    fileCount: candidates.length,
  };

  aggregateCache = { ts: now, data };
  return data;
}

export function invalidateStatsCache() {
  aggregateCache = { ts: 0, data: null };
}
