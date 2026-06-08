import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import chokidar from 'chokidar';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scanAllSessions, loadSession, getProjectsDir } from './lib/sessions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4173;

const app = express();
app.use(express.static(join(__dirname, 'public')));

app.get('/api/sessions', async (req, res) => {
  try {
    const sessions = await scanAllSessions();
    res.json({ sessions, scannedAt: new Date().toISOString() });
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

  scanAllSessions()
    .then((sessions) => {
      ws.send(JSON.stringify({ type: 'snapshot', sessions }));
    })
    .catch((err) => console.error('[ws] initial scan failed:', err.message));
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
    const sessions = await scanAllSessions();
    broadcast({ type: 'snapshot', sessions });
  } catch (err) {
    console.error('[periodic] scan failed:', err.message);
  }
}, PERIODIC_REFRESH_MS);

const projectsDir = getProjectsDir();
const watcher = chokidar.watch(`${projectsDir.replace(/\\/g, '/')}/**/*.jsonl`, {
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
});

watcher.on('add', scheduleRefresh);
watcher.on('change', scheduleRefresh);
watcher.on('error', (err) => console.error('[watch] error:', err.message));

server.listen(PORT, () => {
  console.log(`\n  TWINO Agents Dashboard`);
  console.log(`  ─────────────────────────`);
  console.log(`  Watching: ${projectsDir}`);
  console.log(`  Open:     http://localhost:${PORT}\n`);
});

process.on('SIGINT', () => {
  console.log('\n  Shutting down...');
  watcher.close();
  server.close(() => process.exit(0));
});
