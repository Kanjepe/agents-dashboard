import { readFile, readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

const ACTIVE_WINDOW_MS = 30 * 1000;
const STALE_WINDOW_MS = 5 * 60 * 1000;
const TOOL_HISTORY_LIMIT = 50;

const FULL_PARSE_WINDOW_MS = 24 * 60 * 60 * 1000;
const SHOW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const sessionCache = new Map();

export function decodeProjectDirName(dirName) {
  if (/^[a-z]--/i.test(dirName)) {
    const drive = dirName[0].toUpperCase();
    const rest = dirName.slice(3).replace(/-/g, '\\');
    return `${drive}:\\${rest}`;
  }
  return dirName.replace(/-/g, '/');
}

export function shortProjectName(fullPath) {
  if (!fullPath) return 'unknown';
  const parts = fullPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || fullPath;
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
  let currentTool = null;
  let lastAssistantToolUseId = null;
  let lastToolResultId = null;
  let userMessageCount = 0;
  let assistantMessageCount = 0;

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
        tokens.input += usage.input_tokens || 0;
        tokens.output += usage.output_tokens || 0;
        tokens.cacheRead += usage.cache_read_input_tokens || 0;
        tokens.cacheCreate += usage.cache_creation_input_tokens || 0;
      }

      const content = entry.message.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === 'tool_use') {
            const name = part.name || 'unknown';
            toolUsage[name] = (toolUsage[name] || 0) + 1;
            toolHistory.push({ t: entry.timestamp, name });
            currentTool = name;
            lastAssistantToolUseId = part.id;
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

  let status;
  const waitingForToolResult =
    lastAssistantToolUseId && lastAssistantToolUseId !== lastToolResultId;
  if (ageMs < ACTIVE_WINDOW_MS) {
    status = 'active';
  } else if (ageMs < STALE_WINDOW_MS && waitingForToolResult) {
    status = 'waiting';
  } else if (ageMs < STALE_WINDOW_MS) {
    status = 'recent';
  } else {
    status = 'idle';
  }

  const firstTs = firstTimestamp ? new Date(firstTimestamp).getTime() : null;
  const durationMs = firstTs ? lastTs - firstTs : 0;
  const liveTool = status === 'active' || status === 'waiting' ? currentTool : null;

  return {
    sessionId,
    title,
    model: model || 'unknown',
    projectPath: cwd,
    projectName: shortProjectName(cwd),
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
    toolUsage,
    toolCount: Object.values(toolUsage).reduce((a, b) => a + b, 0),
    toolHistory: recentHistory,
    currentTool: liveTool,
    userMessageCount,
    assistantMessageCount,
    fileSize: fileStats.size,
  };
}

function makeStubSession(sessionId, fileStats, projectDir) {
  const projectPath = decodeProjectDirName(projectDir);
  const ageMs = Date.now() - fileStats.mtimeMs;
  return {
    sessionId,
    title: null,
    model: 'unknown',
    projectPath,
    projectName: shortProjectName(projectPath),
    projectDir,
    gitBranch: null,
    status: 'idle',
    startTime: null,
    lastActivity: new Date(fileStats.mtimeMs).toISOString(),
    ageSeconds: Math.floor(ageMs / 1000),
    durationSeconds: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
    toolUsage: {},
    toolCount: 0,
    toolHistory: [],
    currentTool: null,
    userMessageCount: 0,
    assistantMessageCount: 0,
    fileSize: fileStats.size,
    stub: true,
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
  for (const cand of fileCandidates) {
    const ageMs = now - cand.fileStats.mtimeMs;
    if (ageMs > SHOW_WINDOW_MS) continue;

    const sessionId = basename(cand.file, '.jsonl');

    if (ageMs > FULL_PARSE_WINDOW_MS) {
      sessions.push(makeStubSession(sessionId, cand.fileStats, cand.projectDir));
      continue;
    }

    const cacheKey = cand.filePath;
    const cached = sessionCache.get(cacheKey);
    if (cached && cached.mtimeMs === cand.fileStats.mtimeMs) {
      sessions.push(cached.session);
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
        sessions.push(session);
      }
    } catch (err) {
      console.error(`[sessions] failed to parse ${cand.filePath}:`, err.message);
    }
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
  return session;
}

export function getProjectsDir() {
  return CLAUDE_PROJECTS_DIR;
}
