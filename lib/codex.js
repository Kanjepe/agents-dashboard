// Codex (OpenAI) CLI session telemetry adapter.
// Reads ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl and emits the SAME stats
// data contract as aggregateStats() (see buildStatsData in stats.js), so the
// dashboard renders both providers with identical code.
// Format notes: docs/plans/2026-08-04-codex-provider-design.md

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
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
const LIVE_WINDOW_MS = 2 * 60 * 1000;
const PAUSED_WINDOW_MS = 30 * 60 * 1000;
const TOOL_HISTORY_LIMIT = 50;
const RECENT_MSG_WINDOW_MS = 60 * 60 * 1000;
const BURN_WINDOW_MS = 5 * 60 * 1000;

const fileCache = new Map();
const sessionCache = new Map();
let aggregateCache = { ts: 0, data: null };

function parseRolloutLines(content) {
  const entries = [];
  for (const line of String(content || '').split('\n')) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Ignore partially written and invalid lines.
    }
  }
  return entries;
}

function titleFromMessage(message) {
  const text = String(message || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function toolDetail(payload) {
  const input = payload?.input ?? payload?.arguments;
  if (!input) return null;
  if (typeof input === 'object') {
    return input.tool || input.name || null;
  }
  const matches = Array.from(String(input).matchAll(/tools\.([a-zA-Z0-9_]+)/g));
  if (matches.length === 0) return null;
  return Array.from(new Set(matches.map((match) => match[1]))).join(', ');
}

function isToolCall(payload) {
  return [
    'custom_tool_call',
    'function_call',
    'local_shell_call',
    'web_search_call',
  ].includes(payload?.type);
}

function isToolOutput(payload) {
  return [
    'custom_tool_call_output',
    'function_call_output',
    'local_shell_call_output',
  ].includes(payload?.type);
}

function freshenCodexSession(session, nowMs = Date.now()) {
  if (!session || !session._lastTs) return session;
  const ageMs = nowMs - session._lastTs;
  let status;
  if (ageMs < LIVE_WINDOW_MS) {
    status = 'live';
  } else if (session._waitingForToolResult && ageMs < PAUSED_WINDOW_MS) {
    status = 'waiting';
  } else if (ageMs < PAUSED_WINDOW_MS) {
    status = 'paused';
  } else {
    status = 'idle';
  }
  const showCurrentTool = status === 'live' || status === 'waiting';
  const burnWindow = (session._messageTokens || []).filter(
    (message) => nowMs - message.t < BURN_WINDOW_MS,
  );
  return {
    ...session,
    status,
    ageSeconds: Math.max(0, Math.floor(ageMs / 1000)),
    currentTool: showCurrentTool ? session._rawCurrentTool : null,
    currentToolDetail: showCurrentTool ? session._rawCurrentToolDetail : null,
    tokensLast5Min: burnWindow.reduce((sum, message) => sum + message.tokens, 0),
    costLast5Min: burnWindow.reduce((sum, message) => sum + message.cost, 0),
  };
}

export function aggregateCodexSession(
  fallbackSessionId,
  content,
  fileStats,
  nowMs = Date.now(),
) {
  const entries = parseRolloutLines(content);
  if (entries.length === 0) return null;

  let sessionId = fallbackSessionId;
  let projectPath = null;
  let model = 'unknown';
  let title = null;
  let firstTimestamp = null;
  let lastTimestamp = null;
  let userMessageCount = 0;
  let assistantMessageCount = 0;
  let totalCostUsd = 0;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 };
  const toolUsage = {};
  const toolHistory = [];
  const pendingTools = new Map();
  const messageTokens = [];

  for (const entry of entries) {
    if (entry.timestamp) {
      if (!firstTimestamp) firstTimestamp = entry.timestamp;
      lastTimestamp = entry.timestamp;
    }

    const payload = entry.payload || {};
    if (entry.type === 'session_meta') {
      sessionId = payload.id || payload.session_id || sessionId;
      projectPath = payload.cwd || projectPath;
    }
    if (entry.type === 'turn_context') {
      projectPath = payload.cwd || projectPath;
      model = payload.model || model;
    }

    if (entry.type === 'event_msg' && payload.type === 'user_message') {
      userMessageCount += 1;
      if (!title) title = titleFromMessage(payload.message);
    }
    if (entry.type === 'event_msg' && payload.type === 'agent_message') {
      assistantMessageCount += 1;
    }
    if (entry.type === 'event_msg' && payload.type === 'token_count') {
      const usage = payload.info?.last_token_usage;
      if (!usage) continue;
      const input = usage.input_tokens || 0;
      const cachedInput = usage.cached_input_tokens || 0;
      const output = usage.output_tokens || 0;
      const total = usage.total_tokens || input + output;
      const cost = codexEstimateCostUsd(
        { input, cachedInput, output, total },
        model,
        entry.timestamp,
      );
      tokens.input += Math.max(0, input - cachedInput);
      tokens.cacheRead += cachedInput;
      tokens.output += output;
      tokens.total += total;
      totalCostUsd += cost;
      if (entry.timestamp) {
        messageTokens.push({
          t: new Date(entry.timestamp).getTime(),
          tokens: total,
          cost,
        });
      }
    }

    if (entry.type === 'response_item' && isToolCall(payload)) {
      const name = payload.name || (payload.type === 'web_search_call' ? 'web_search' : 'shell');
      const callId = payload.call_id || payload.id;
      const action = { name, detail: toolDetail(payload) };
      toolUsage[name] = (toolUsage[name] || 0) + 1;
      toolHistory.push({ t: entry.timestamp, name });
      if (callId) pendingTools.set(callId, action);
    }
    if (entry.type === 'response_item' && isToolOutput(payload)) {
      const callId = payload.call_id || payload.id;
      if (callId) pendingTools.delete(callId);
    }
  }

  const lastTs = lastTimestamp ? new Date(lastTimestamp).getTime() : fileStats.mtimeMs;
  const firstTs = firstTimestamp ? new Date(firstTimestamp).getTime() : lastTs;
  const recentMessages = messageTokens.filter(
    (message) => nowMs - message.t < RECENT_MSG_WINDOW_MS,
  );
  const pending = Array.from(pendingTools.values()).at(-1) || null;
  const baseSession = {
    provider: 'codex',
    sessionId,
    title,
    model,
    projectPath,
    projectName: shortProjectName(projectPath),
    isObserver: false,
    observedProject: null,
    gitBranch: null,
    status: 'idle',
    startTime: firstTimestamp,
    lastActivity: new Date(lastTs).toISOString(),
    ageSeconds: 0,
    durationSeconds: Math.max(0, Math.floor((lastTs - firstTs) / 1000)),
    tokens,
    costUsd: Math.round(totalCostUsd * 10000) / 10000,
    tokensLast5Min: 0,
    costLast5Min: 0,
    toolUsage,
    toolCount: Object.values(toolUsage).reduce((sum, count) => sum + count, 0),
    toolHistory: toolHistory.slice(-TOOL_HISTORY_LIMIT),
    currentTool: null,
    currentToolDetail: null,
    subagents: [],
    skills: [],
    userMessageCount,
    assistantMessageCount,
    fileSize: fileStats.size,
    _lastTs: lastTs,
    _rawCurrentTool: pending?.name || null,
    _rawCurrentToolDetail: pending?.detail || null,
    _waitingForToolResult: pendingTools.size > 0,
    _messageTokens: recentMessages,
  };
  return freshenCodexSession(baseSession, nowMs);
}

async function readCodexSession(filePath, fileStats) {
  const cached = sessionCache.get(filePath);
  if (cached && cached.mtimeMs === fileStats.mtimeMs) {
    return freshenCodexSession(cached.session);
  }
  const content = await readFile(filePath, 'utf8');
  const fallbackId = basename(filePath, '.jsonl');
  const session = aggregateCodexSession(fallbackId, content, fileStats);
  if (!session) return null;
  session.filePath = filePath;
  sessionCache.set(filePath, { mtimeMs: fileStats.mtimeMs, session });
  return session;
}

export async function scanCodexSessions() {
  let entries;
  try {
    entries = await readdir(CODEX_SESSIONS_DIR, { recursive: true });
  } catch {
    return [];
  }

  const now = Date.now();
  const candidates = [];
  for (const rel of entries) {
    if (!String(rel).endsWith('.jsonl')) continue;
    const filePath = join(CODEX_SESSIONS_DIR, String(rel));
    try {
      const fileStats = await stat(filePath);
      if (now - fileStats.mtimeMs <= PAUSED_WINDOW_MS) {
        candidates.push({ filePath, fileStats });
      }
    } catch {
      // Skip files that disappear during the scan.
    }
  }
  candidates.sort((a, b) => b.fileStats.mtimeMs - a.fileStats.mtimeMs);

  const visiblePaths = new Set(candidates.map((candidate) => candidate.filePath));
  const sessions = [];
  for (const candidate of candidates) {
    try {
      const session = await readCodexSession(candidate.filePath, candidate.fileStats);
      if (session) sessions.push(session);
    } catch (err) {
      console.error(`[codex-sessions] failed to parse ${candidate.filePath}:`, err.message);
    }
  }
  for (const key of sessionCache.keys()) {
    if (!visiblePaths.has(key)) sessionCache.delete(key);
  }
  return sessions;
}

export async function loadCodexSession(filePath) {
  const fileStats = await stat(filePath);
  return readCodexSession(filePath, fileStats);
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
    const cost = codexEstimateCostUsd(ev.usage, ev.model, ev.timestamp);
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
