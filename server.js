import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import chokidar from 'chokidar';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scanAllSessions, loadSession, getProjectsDir } from './lib/sessions.js';
import { detectClaudeProcesses } from './lib/processes.js';
import { aggregateStats, invalidateStatsCache } from './lib/stats.js';

async function buildSnapshot() {
  const [sessions, processes, stats] = await Promise.all([
    scanAllSessions(),
    detectClaudeProcesses(),
    aggregateStats(),
  ]);
  return { sessions, processes, stats, scannedAt: new Date().toISOString() };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4173;

const app = express();
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

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

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

server.listen(PORT, () => {
  console.log(`\n  Agents Dashboard`);
  console.log(`  ─────────────────────────`);
  console.log(`  Watching: ${projectsDir}`);
  console.log(`  Open:     http://localhost:${PORT}\n`);
});

process.on('SIGINT', () => {
  console.log('\n  Shutting down...');
  watcher.close();
  server.close(() => process.exit(0));
});
