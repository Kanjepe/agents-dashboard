import { readFile, readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { SKILL_BLACKLIST, decodeProjectDirName, shortProjectName, usageBreakdown } from './utils.js';
import { estimateCostUsd } from './pricing.js';

// Re-exported for backward compat (tests/sessions.test.js imports them
// from this module).
export { decodeProjectDirName, shortProjectName };

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

const LIVE_WINDOW_MS = 2 * 60 * 1000;
const PAUSED_WINDOW_MS = 30 * 60 * 1000;
const TOOL_HISTORY_LIMIT = 50;
const RECENT_MSG_WINDOW_MS = 60 * 60 * 1000; // keep last 60 min of message-token events
const BURN_WINDOW_MS = 5 * 60 * 1000; // burn rate computed over last 5 min

const SHOW_WINDOW_MS = PAUSED_WINDOW_MS;

const OBSERVER_PATH_RE = /[\\/](?:claude-mem)?[\\/]?observer-sessions/i;
const WORKING_DIR_RE = /<working_directory>([^<]+)<\/working_directory>/g;

const sessionCache = new Map();

export function isObserverPath(cwd) {
  return !!cwd && OBSERVER_PATH_RE.test(cwd);
}

export function extractObservedProject(entries) {
  let last = null;
  for (const entry of entries) {
    if (entry.type !== 'user' || !entry.message?.content) continue;
    const content = entry.message.content;
    const text = Array.isArray(content)
      ? content.map((p) => (typeof p === 'string' ? p : p.text || '')).join('\n')
      : String(content || '');
    if (!text || !text.includes('<working_directory>')) continue;
    let m;
    WORKING_DIR_RE.lastIndex = 0;
    while ((m = WORKING_DIR_RE.exec(text)) !== null) {
      last = m[1].trim();
    }
  }
  return last;
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function readSessionFile(filePath) {
  return readFile(filePath, 'utf8').then((content) => {
    const lines = content.split('\n').filter(Boolean);
    return lines.map(parseLine).filter(Boolean);
  });
}

export function aggregateSession(sessionId, entries, fileStats) {
  if (entries.length === 0) {
    return null;
  }

  let title = null;
  let model = null;
  let cwd = null;
  let gitBranch = null;
  let firstTimestamp = null;
  let lastTimestamp = null;
  const tokens = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
  };
  const toolUsage = {};
  const toolHistory = [];
  const messageTokens = [];
  let totalCostUsd = 0;
  let currentTool = null;
  let currentToolDetail = null;
  let lastAssistantToolUseId = null;
  let lastToolResultId = null;
  let userMessageCount = 0;
  let assistantMessageCount = 0;
  const subagents = [];
  const skills = [];
  const subagentIndex = new Map();

  for (const entry of entries) {
    if (entry.timestamp) {
      if (!firstTimestamp) firstTimestamp = entry.timestamp;
      lastTimestamp = entry.timestamp;
    }
    if (entry.cwd) cwd = entry.cwd;
    if (entry.gitBranch) gitBranch = entry.gitBranch;
    if (entry.type === 'ai-title' && entry.title) title = entry.title;

    if (entry.type === 'assistant' && entry.message) {
      assistantMessageCount += 1;
      if (entry.message.model) model = entry.message.model;

      const usage = entry.message.usage;
      if (usage) {
        const u = usageBreakdown(usage);
        tokens.input += u.input;
        tokens.output += u.output;
        tokens.cacheRead += u.cacheRead;
        tokens.cacheCreate += u.cacheCreate5m + u.cacheCreate1h;
        if (entry.timestamp) {
          const msgModel = entry.message.model || model;
          const msgCost = estimateCostUsd(u, msgModel, entry.timestamp);
          totalCostUsd += msgCost;
          messageTokens.push({
            t: new Date(entry.timestamp).getTime(),
            tokens: u.total,
            cost: msgCost,
          });
        }
      }

      const content = entry.message.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === 'tool_use') {
            const name = part.name || 'unknown';
            toolUsage[name] = (toolUsage[name] || 0) + 1;
            toolHistory.push({ t: entry.timestamp, name });
            currentTool = name;
            currentToolDetail = null;
            lastAssistantToolUseId = part.id;

            if (name === 'Task' && part.input?.subagent_type) {
              const sub = {
                toolUseId: part.id,
                type: part.input.subagent_type,
                description: part.input.description || '',
                timestamp: entry.timestamp,
                completed: false,
                durationMs: null,
              };
              subagents.push(sub);
              subagentIndex.set(part.id, sub);
              currentToolDetail = part.input.subagent_type;
            }
            if (name === 'Skill' && part.input?.skill) {
              const skillName = part.input.skill;
              if (!SKILL_BLACKLIST.has(skillName.toLowerCase())) {
                skills.push({
                  toolUseId: part.id,
                  name: skillName,
                  timestamp: entry.timestamp,
                });
                currentToolDetail = skillName;
              }
            }
          }
        }
      }
    }

    if (entry.type === 'user' && entry.message) {
      const content = entry.message.content;
      let hasUserText = false;
      if (typeof content === 'string' && content.length > 0) {
        hasUserText = true;
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === 'tool_result') {
            lastToolResultId = part.tool_use_id;
            const sub = subagentIndex.get(part.tool_use_id);
            if (sub) {
              sub.completed = true;
              sub.durationMs =
                new Date(entry.timestamp).getTime() - new Date(sub.timestamp).getTime();
            }
          } else if (part.type === 'text' || typeof part === 'string') {
            hasUserText = true;
          }
        }
      }
      if (hasUserText) userMessageCount += 1;
    }
  }

  const recentHistory = toolHistory.slice(-TOOL_HISTORY_LIMIT);
  const now = Date.now();
  const lastTs = lastTimestamp ? new Date(lastTimestamp).getTime() : fileStats.mtimeMs;
  const ageMs = now - lastTs;

  const recentMessageTokens = messageTokens.filter((m) => now - m.t < RECENT_MSG_WINDOW_MS);

  let status;
  const waitingForToolResult =
    lastAssistantToolUseId && lastAssistantToolUseId !== lastToolResultId;
  if (ageMs < LIVE_WINDOW_MS) {
    status = 'live';
  } else if (waitingForToolResult && ageMs < PAUSED_WINDOW_MS) {
    status = 'waiting';
  } else if (ageMs < PAUSED_WINDOW_MS) {
    status = 'paused';
  } else {
    status = 'idle';
  }

  const firstTs = firstTimestamp ? new Date(firstTimestamp).getTime() : null;
  const durationMs = firstTs ? lastTs - firstTs : 0;
  const liveTool = status === 'live' || status === 'waiting' ? currentTool : null;
  const liveToolDetail = status === 'live' || status === 'waiting' ? currentToolDetail : null;

  const observerOf = isObserverPath(cwd) ? extractObservedProject(entries) : null;
  const isObserver = !!observerOf;
  const observedSlug = observerOf ? shortProjectName(observerOf) : null;
  const projectName = isObserver
    ? `obs/${observedSlug}`
    : shortProjectName(cwd);
  const projectPath = observerOf || cwd;

  const burnWindow = recentMessageTokens.filter((m) => now - m.t < BURN_WINDOW_MS);
  const tokensLast5Min = burnWindow.reduce((s, m) => s + m.tokens, 0);
  const costLast5Min = burnWindow.reduce((s, m) => s + (m.cost || 0), 0);
  // Per-message sum: correct across mid-session model switches and TTL splits.
  const costUsd = Math.round(totalCostUsd * 10000) / 10000;

  return {
    provider: 'claude',
    sessionId,
    title,
    model: model || 'unknown',
    projectPath,
    projectName,
    isObserver,
    observedProject: observerOf || null,
    gitBranch,
    status,
    startTime: firstTimestamp,
    lastActivity: new Date(lastTs).toISOString(),
    ageSeconds: Math.floor(ageMs / 1000),
    durationSeconds: Math.floor(durationMs / 1000),
    tokens: {
      ...tokens,
      total: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreate,
    },
    costUsd,
    tokensLast5Min,
    costLast5Min,
    toolUsage,
    toolCount: Object.values(toolUsage).reduce((a, b) => a + b, 0),
    toolHistory: recentHistory,
    currentTool: liveTool,
    currentToolDetail: liveToolDetail,
    subagents,
    skills,
    userMessageCount,
    assistantMessageCount,
    fileSize: fileStats.size,
    _lastTs: lastTs,
    _rawCurrentTool: currentTool,
    _rawCurrentToolDetail: currentToolDetail,
    _waitingForToolResult: !!waitingForToolResult,
    _messageTokens: recentMessageTokens,
  };
}

function freshenSession(session) {
  if (!session || !session._lastTs) return session;
  const now = Date.now();
  const ageMs = now - session._lastTs;
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
  const isLive = status === 'live' || status === 'waiting';
  const burnWindow = (session._messageTokens || []).filter(
    (m) => now - m.t < BURN_WINDOW_MS,
  );
  const tokensLast5Min = burnWindow.reduce((s, m) => s + m.tokens, 0);
  const costLast5Min = burnWindow.reduce((s, m) => s + (m.cost || 0), 0);
  return {
    ...session,
    status,
    ageSeconds: Math.max(0, Math.floor(ageMs / 1000)),
    currentTool: isLive ? session._rawCurrentTool : null,
    currentToolDetail: isLive ? session._rawCurrentToolDetail : null,
    tokensLast5Min,
    costLast5Min,
  };
}

export async function scanAllSessions() {
  let projectDirs;
  try {
    projectDirs = await readdir(CLAUDE_PROJECTS_DIR);
  } catch {
    return [];
  }

  const now = Date.now();
  const fileCandidates = [];

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
        fileCandidates.push({ filePath, fileStats, projectDir, file });
      } catch {
        // skip
      }
    }
  }

  fileCandidates.sort((a, b) => b.fileStats.mtimeMs - a.fileStats.mtimeMs);

  const sessions = [];
  const visiblePaths = new Set();

  for (const cand of fileCandidates) {
    const ageMs = now - cand.fileStats.mtimeMs;
    if (ageMs > SHOW_WINDOW_MS) continue;

    const sessionId = basename(cand.file, '.jsonl');
    const cacheKey = cand.filePath;
    visiblePaths.add(cacheKey);
    const cached = sessionCache.get(cacheKey);
    if (cached && cached.mtimeMs === cand.fileStats.mtimeMs) {
      sessions.push(freshenSession(cached.session));
      continue;
    }

    try {
      const entries = await readSessionFile(cand.filePath);
      const session = aggregateSession(sessionId, entries, cand.fileStats);
      if (session) {
        session.projectDir = cand.projectDir;
        if (!session.projectPath) {
          session.projectPath = decodeProjectDirName(cand.projectDir);
          session.projectName = shortProjectName(session.projectPath);
        }
        session.filePath = cand.filePath;
        sessionCache.set(cacheKey, { mtimeMs: cand.fileStats.mtimeMs, session });
        sessions.push(freshenSession(session));
      }
    } catch (err) {
      console.error(`[sessions] failed to parse ${cand.filePath}:`, err.message);
    }
  }

  for (const key of sessionCache.keys()) {
    if (!visiblePaths.has(key)) sessionCache.delete(key);
  }

  sessions.sort((a, b) => {
    const aTs = new Date(a.lastActivity).getTime();
    const bTs = new Date(b.lastActivity).getTime();
    return bTs - aTs;
  });

  return sessions;
}

export async function loadSession(filePath) {
  const fileStats = await stat(filePath);
  const sessionId = basename(filePath, '.jsonl');
  const entries = await readSessionFile(filePath);
  const session = aggregateSession(sessionId, entries, fileStats);
  if (!session) return null;
  session.filePath = filePath;
  if (!session.projectPath) {
    const projectDir = basename(join(filePath, '..'));
    session.projectPath = decodeProjectDirName(projectDir);
    session.projectName = shortProjectName(session.projectPath);
  }
  sessionCache.set(filePath, { mtimeMs: fileStats.mtimeMs, session });
  return freshenSession(session);
}

export function getProjectsDir() {
  return CLAUDE_PROJECTS_DIR;
}
