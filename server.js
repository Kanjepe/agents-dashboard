import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import chokidar from 'chokidar';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scanAllSessions, loadSession, getProjectsDir } from './lib/sessions.js';
import { detectClaudeProcesses } from './lib/processes.js';
import { aggregateStats, invalidateStatsCache } from './lib/stats.js';
import { aggregateCodexStats } from './lib/codex.js';
import { getRegistry, getSkillDetail, getAgentDetail } from './lib/registry.js';

function aggregateActivity(sessions) {
  const agentsByType = new Map();
  const skillsByName = new Map();
  const timeline = [];

  for (const s of sessions) {
    const parentName = s.projectName || 'unknown';

    for (const sub of s.subagents || []) {
      let bucket = agentsByType.get(sub.type);
      if (!bucket) {
        bucket = {
          type: sub.type,
          activeCount: 0,
          totalCount: 0,
          totalDurationMs: 0,
          completedCount: 0,
          parents: new Map(),
          history: [],
          lastSeen: '',
        };
        agentsByType.set(sub.type, bucket);
      }
      bucket.totalCount += 1;
      if (!sub.completed) bucket.activeCount += 1;
      if (sub.completed && sub.durationMs != null) {
        bucket.totalDurationMs += sub.durationMs;
        bucket.completedCount += 1;
      }
      bucket.history.push({ t: sub.timestamp });
      if (!bucket.lastSeen || sub.timestamp > bucket.lastSeen) {
        bucket.lastSeen = sub.timestamp;
      }

      let parent = bucket.parents.get(s.sessionId);
      if (!parent) {
        parent = { sessionId: s.sessionId, projectName: parentName, count: 0, activeCount: 0 };
        bucket.parents.set(s.sessionId, parent);
      }
      parent.count += 1;
      if (!sub.completed) parent.activeCount += 1;

      timeline.push({
        kind: 'agent',
        timestamp: sub.timestamp,
        name: sub.type,
        description: sub.description,
        completed: sub.completed,
        durationMs: sub.durationMs,
        sessionId: s.sessionId,
        projectName: parentName,
      });
    }

    for (const sk of s.skills || []) {
      let bucket = skillsByName.get(sk.name);
      if (!bucket) {
        bucket = {
          name: sk.name,
          totalCount: 0,
          parents: new Map(),
          history: [],
          lastSeen: '',
        };
        skillsByName.set(sk.name, bucket);
      }
      bucket.totalCount += 1;
      bucket.history.push({ t: sk.timestamp });
      if (!bucket.lastSeen || sk.timestamp > bucket.lastSeen) {
        bucket.lastSeen = sk.timestamp;
      }

      let parent = bucket.parents.get(s.sessionId);
      if (!parent) {
        parent = { sessionId: s.sessionId, projectName: parentName, count: 0 };
        bucket.parents.set(s.sessionId, parent);
      }
      parent.count += 1;

      timeline.push({
        kind: 'skill',
        timestamp: sk.timestamp,
        name: sk.name,
        sessionId: s.sessionId,
        projectName: parentName,
      });
    }
  }

  timeline.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

  const finalize = (bucket) => ({
    ...bucket,
    parents: Array.from(bucket.parents.values()).sort((a, b) => b.count - a.count),
  });

  return {
    agents: Array.from(agentsByType.values())
      .map(finalize)
      .sort((a, b) => b.activeCount - a.activeCount || (a.lastSeen < b.lastSeen ? 1 : -1)),
    skills: Array.from(skillsByName.values())
      .map(finalize)
      .sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1)),
    timeline: timeline.slice(0, 120),
  };
}

async function buildSnapshot() {
  const [sessions, processes, stats, statsCodex, registry] = await Promise.all([
    scanAllSessions(),
    detectClaudeProcesses(),
    aggregateStats(),
    aggregateCodexStats(),
    getRegistry(),
  ]);
  const activity = aggregateActivity(sessions);
  return {
    sessions,
    processes,
    stats,
    statsCodex,
    activity,
    registry,
    scannedAt: new Date().toISOString(),
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '127.0.0.1';

const app = express();

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: [
          "'self'",
          `ws://localhost:${PORT}`,
          `ws://127.0.0.1:${PORT}`,
        ],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', apiLimiter);

app.use(express.static(join(__dirname, 'public')));

app.get('/api/sessions', async (req, res) => {
  try {
    res.json(await buildSnapshot());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, projectsDir: getProjectsDir() });
});

const SAFE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

app.get('/api/skill/:slug', async (req, res) => {
  if (!SAFE_NAME_RE.test(req.params.slug)) {
    return res.status(400).json({ error: 'invalid slug' });
  }
  const detail = await getSkillDetail(req.params.slug);
  if (!detail) return res.status(404).json({ error: 'not found' });
  res.json(detail);
});

app.get('/api/agent/:domain/:slug', async (req, res) => {
  if (!SAFE_NAME_RE.test(req.params.domain) || !SAFE_NAME_RE.test(req.params.slug)) {
    return res.status(400).json({ error: 'invalid name' });
  }
  const detail = await getAgentDetail(req.params.domain, req.params.slug);
  if (!detail) return res.status(404).json({ error: 'not found' });
  res.json(detail);
});

const server = createServer(app);

const ALLOWED_WS_ORIGINS = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  `http://[::1]:${PORT}`,
]);

const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: (info, cb) => {
    const origin = info.origin || '';
    if (!origin || ALLOWED_WS_ORIGINS.has(origin)) {
      cb(true);
    } else {
      cb(false, 403, 'forbidden origin');
    }
  },
});

const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));

  buildSnapshot()
    .then((snap) => {
      ws.send(JSON.stringify({ type: 'snapshot', ...snap }));
    })
    .catch((err) => console.error('[ws] initial snapshot failed:', err.message));
});

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(data);
    }
  }
}

const REFRESH_DEBOUNCE_MS = 400;
let refreshTimer = null;
const pendingFiles = new Set();

function scheduleRefresh(filePath) {
  pendingFiles.add(filePath);
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    const files = Array.from(pendingFiles);
    pendingFiles.clear();
    refreshTimer = null;
    for (const file of files) {
      try {
        const session = await loadSession(file);
        if (session) {
          broadcast({ type: 'session-update', session });
        }
      } catch (err) {
        console.error(`[watch] failed to load ${file}:`, err.message);
      }
    }
  }, REFRESH_DEBOUNCE_MS);
}

const PERIODIC_REFRESH_MS = 5000;
setInterval(async () => {
  try {
    const snap = await buildSnapshot();
    broadcast({ type: 'snapshot', ...snap });
  } catch (err) {
    console.error('[periodic] scan failed:', err.message);
  }
}, PERIODIC_REFRESH_MS);

const projectsDir = getProjectsDir();
const watcher = chokidar.watch(`${projectsDir.replace(/\\/g, '/')}/**/*.jsonl`, {
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
});

function onJsonlChange(filePath) {
  invalidateStatsCache();
  scheduleRefresh(filePath);
}

watcher.on('add', onJsonlChange);
watcher.on('change', onJsonlChange);
watcher.on('error', (err) => console.error('[watch] error:', err.message));

server.listen(PORT, HOST, () => {
  const displayHost = HOST === '127.0.0.1' || HOST === '::1' ? 'localhost' : HOST;
  console.log(`\n  AI Session Telemetry`);
  console.log(`  ─────────────────────────`);
  console.log(`  Watching: ${projectsDir}`);
  console.log(`  Bind:     ${HOST}:${PORT}`);
  console.log(`  Open:     http://${displayHost}:${PORT}\n`);
});

process.on('SIGINT', () => {
  console.log('\n  Shutting down...');
  watcher.close();
  server.close(() => process.exit(0));
});
