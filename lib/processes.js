import { exec } from 'node:child_process';

const PROCESS_CACHE_MS = 4000;
let cache = { ts: 0, processes: [] };

function runCmd(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve('');
      } else {
        resolve(stdout || '');
      }
    });
  });
}

function safeJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function listWindowsProcesses() {
  const stdout = await runCmd(
    'powershell -NoProfile -Command "Get-Process -Name claude -ErrorAction SilentlyContinue | Select-Object Id, StartTime | ConvertTo-Json -Compress"',
  );
  const data = safeJson(stdout);
  if (!data) return [];
  const arr = Array.isArray(data) ? data : [data];
  return arr.map((p) => ({ pid: Number(p.Id), startTime: p.StartTime || null }));
}

async function listUnixProcesses() {
  const stdout = await runCmd('ps -eo pid,command 2>/dev/null | grep -i "[c]laude"');
  if (!stdout) return [];
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pid] = line.split(/\s+/);
      return { pid: Number(pid), startTime: null };
    })
    .filter((p) => Number.isFinite(p.pid));
}

export async function detectClaudeProcesses() {
  const now = Date.now();
  if (now - cache.ts < PROCESS_CACHE_MS) {
    return cache.processes;
  }
  const processes =
    process.platform === 'win32' ? await listWindowsProcesses() : await listUnixProcesses();
  cache = { ts: now, processes };
  return processes;
}
