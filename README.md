# Agents Dashboard

Local real-time dashboard for monitoring Claude Code sessions and subagents — a passive read-only observer over `~/.claude/projects/` JSONL files.

Works for anyone running Claude Code locally; no organization-specific assumptions.

![status](https://img.shields.io/badge/status-MVP-7AB648)
![node](https://img.shields.io/badge/node-%3E%3D18-7AB648)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-7AB648)

---

## Table of Contents

1. [What it does](#what-it-does)
2. [Quick start (this PC)](#quick-start-this-pc)
3. [Install on a different PC](#install-on-a-different-pc)
4. [How to launch the server](#how-to-launch-the-server)
5. [Auto-start on boot](#auto-start-on-boot)
6. [Configuration](#configuration)
7. [Troubleshooting](#troubleshooting)
8. [Architecture](#architecture)

---

## What it does

- Watches every Claude Code session JSONL file in real time
- Renders one card per session: status, model, tokens, tool usage, current tool, sparkline history
- Live updates via WebSocket — no manual refresh needed
- 100% passive: does not modify any agent, skill, MCP server, or setting

---

## Quick start

Requirements: **Node.js 18 or newer** and an active Claude Code installation (so that `~/.claude/projects/` exists on your machine).

```bash
git clone https://github.com/Kanjepe/agents-dashboard.git
cd agents-dashboard
npm install
npm start
```

Then open <http://localhost:4173> in any browser.

On Windows you can also double-click `start.bat` after the first `npm install` — it starts the server and opens the browser automatically.

To stop the server: press `Ctrl+C` in the terminal.

> The dashboard reads from `~/.claude/projects/` on the machine it runs on. It does not connect to anything remote. Run it on the same PC where Claude Code is installed.

---

## Install on a different PC

### Step 1 — Install Node.js

Pick the one that matches the target OS:

| OS | How |
|---|---|
| **Windows** | Download LTS installer from <https://nodejs.org/> and run it. Or via winget: `winget install OpenJS.NodeJS.LTS` |
| **macOS** | `brew install node` (requires [Homebrew](https://brew.sh/)) |
| **Linux** | `sudo apt install nodejs npm` (Debian/Ubuntu) or use your package manager |

Verify:

```bash
node --version    # should print v18.x or newer
npm --version
```

### Step 2 — Copy the project

Pick one of these methods.

**Option A — Copy folder manually**

Copy the entire `agents-dashboard/` folder to the new PC, anywhere you like. **Skip `node_modules/`** — it will be regenerated. The folder you need contains:

```
agents-dashboard/
├── server.js
├── package.json
├── package-lock.json
├── lib/
├── public/
├── start.bat
├── .gitignore
└── README.md
```

**Option B — Via Git**

If you commit this folder to a git repo:

```bash
git clone <your-repo-url> agents-dashboard
cd agents-dashboard
```

**Option C — Zip + transfer**

```powershell
# On source PC (run from the folder ABOVE agents-dashboard):
Compress-Archive -Path ".\agents-dashboard" `
                 -DestinationPath "agents-dashboard.zip" `
                 -Exclude "node_modules"

# Then transfer the zip and extract on the target PC.
```

### Step 3 — Install dependencies

```bash
cd path/to/agents-dashboard
npm install
```

This downloads `express`, `ws`, and `chokidar` into a local `node_modules/` folder (~3 MB).

### Step 4 — Launch

```bash
npm start
```

Then open <http://localhost:4173> in any browser.

> **Important:** the dashboard reads from `~/.claude/projects/` on the **machine it runs on**. It does not connect to remote machines. Run it on the same PC where Claude Code is installed.

---

## How to launch the server

### Method 1 — Double-click `start.bat` (Windows, easiest)

Auto-installs dependencies on first run, starts the server, and opens the browser. Closing the terminal window stops the server.

### Method 2 — From the terminal (cross-platform)

```bash
cd path/to/agents-dashboard
npm start
```

or equivalently:

```bash
node server.js
```

### Method 3 — Dev mode with auto-reload

Useful if you are editing `server.js`:

```bash
npm run dev
```

This uses Node's `--watch` flag to restart the server on file changes.

### Method 4 — Background on Windows (no visible window)

```powershell
cd C:\path\to\agents-dashboard
Start-Process node -ArgumentList "server.js" -WindowStyle Hidden
```

To stop the background server:

```powershell
Get-Process -Name node | Where-Object { $_.Path -like "*\nodejs\*" } | Stop-Process
```

> Be careful — the command above kills **all** node processes. To kill only this server, save the PID:
>
> ```powershell
> $p = Start-Process node -ArgumentList "server.js" -WindowStyle Hidden -PassThru
> $p.Id  # save this number
> # later:
> Stop-Process -Id <that-number>
> ```

### Method 5 — Background on macOS / Linux

```bash
cd path/to/agents-dashboard
nohup node server.js > dashboard.log 2>&1 &
```

To stop:

```bash
pkill -f "node server.js"
```

### Method 6 — Custom port

If port `4173` is taken:

```bash
# Windows PowerShell
$env:PORT = "5000"; node server.js

# macOS / Linux
PORT=5000 node server.js
```

---

## Auto-start on boot

### Windows — Startup folder (easiest)

1. Press `Win + R`, type `shell:startup`, hit Enter
2. Right-click in that folder → New → Shortcut
3. Target: `C:\path\to\agents-dashboard\start.bat`
4. Click Next → name it "Agents Dashboard" → Finish

The dashboard now starts whenever you log in.

### Windows — Task Scheduler (advanced)

For headless start without opening a terminal:

1. Open Task Scheduler → Create Basic Task
2. Trigger: "When I log on"
3. Action: Start a program
   - Program: `node`
   - Arguments: `server.js`
   - Start in: `C:\path\to\agents-dashboard`
4. Finish

### Windows — Run as a Service (advanced)

Use [NSSM](https://nssm.cc/) to run as a true Windows service:

```powershell
nssm install AgentsDashboard "C:\Program Files\nodejs\node.exe" "C:\path\to\agents-dashboard\server.js"
nssm start AgentsDashboard
```

### macOS — launchd

Create `~/Library/LaunchAgents/agents-dashboard.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agents-dashboard</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/agents-dashboard/server.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>/path/to/agents-dashboard</string>
</dict>
</plist>
```

Then:

```bash
launchctl load ~/Library/LaunchAgents/agents-dashboard.plist
```

### Linux — systemd

Create `/etc/systemd/system/agents-dashboard.service`:

```ini
[Unit]
Description=Agents Dashboard
After=network.target

[Service]
Type=simple
User=YOUR_USERNAME
WorkingDirectory=/home/YOUR_USERNAME/agents-dashboard
ExecStart=/usr/bin/node server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl enable agents-dashboard
sudo systemctl start agents-dashboard
```

---

## Configuration

All configurable values live as constants at the top of source files:

| Setting | File | Default | Description |
|---|---|---|---|
| `PORT` | `server.js` (env var) | `4173` | HTTP/WebSocket port |
| `ACTIVE_WINDOW_MS` | `lib/sessions.js` | `30_000` | How recent counts as "active" |
| `STALE_WINDOW_MS` | `lib/sessions.js` | `300_000` | "recent" vs "idle" threshold |
| `FULL_PARSE_WINDOW_MS` | `lib/sessions.js` | `24h` | Older sessions return stubs |
| `SHOW_WINDOW_MS` | `lib/sessions.js` | `7 days` | Older files are hidden |
| `TOOL_HISTORY_LIMIT` | `lib/sessions.js` | `50` | Max tool events kept per card |
| `PERIODIC_REFRESH_MS` | `server.js` | `5000` | Periodic full re-scan interval |
| `REFRESH_DEBOUNCE_MS` | `server.js` | `400` | Debounce window for file events |

To override the port without editing code:

```bash
# Windows PowerShell
$env:PORT = "8080"; npm start

# macOS / Linux
PORT=8080 npm start
```

---

## Troubleshooting

### "No sessions appear"

The dashboard reads from `~/.claude/projects/`. If that folder does not exist, no Claude Code session has run yet on this PC. Open Claude Code once, then refresh the dashboard.

Verify:

```powershell
# Windows
Test-Path "$env:USERPROFILE\.claude\projects"
```

```bash
# macOS / Linux
ls ~/.claude/projects
```

### "Address already in use" / `EADDRINUSE`

Port `4173` is taken by another process. Either:

- Stop the other process, OR
- Run on a different port: `PORT=5000 npm start`

To find the culprit on Windows:

```powershell
Get-NetTCPConnection -LocalPort 4173 | Select-Object OwningProcess
Get-Process -Id <that-pid>
```

### "WebSocket disconnected — retrying…" in the header

The browser cannot reach the server. Confirm the server terminal is still running and the URL matches the port the server printed at startup.

### Server starts but `/api/sessions` is slow

Initial scan parses up to 24h-old sessions. If you have very large JSONL files (>10 MB), the first scan can take a few seconds. Subsequent scans are cached and respond in milliseconds.

### Cards never update in real time

`chokidar` falls back to polling on some network drives. If `~/.claude/projects/` lives on a synced drive (OneDrive, Dropbox), watch events may be delayed. The periodic 5-second rescan acts as a fallback.

### Need to debug

Add a `console.log` in `lib/sessions.js` or `server.js` and run with:

```bash
npm run dev
```

Logs print to the terminal where you started the server.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Claude Code CLI                                        │
│  └─ writes JSONL → ~/.claude/projects/<project>/        │
└──────────────────────────┬──────────────────────────────┘
                           │ file events
                           ▼
┌─────────────────────────────────────────────────────────┐
│  server.js  (Node.js + Express + ws + chokidar)         │
│  ├─ lib/sessions.js  parses JSONL → session objects     │
│  ├─ chokidar watcher debounces file changes             │
│  └─ WebSocket broadcasts updates to all clients         │
└──────────────────────────┬──────────────────────────────┘
                           │ HTTP + WS on :4173
                           ▼
┌─────────────────────────────────────────────────────────┐
│  Browser  (vanilla JS + Tailwind via CDN)               │
│  ├─ public/index.html  shell + filters + header         │
│  ├─ public/app.js      WS client + card rendering       │
│  └─ public/style.css   card animations + theme          │
└─────────────────────────────────────────────────────────┘
```

### Project layout

```
agents-dashboard/
├── server.js              Express + WebSocket + chokidar watcher
├── lib/
│   └── sessions.js        JSONL parser, status logic, mtime cache
├── public/
│   ├── index.html         Layout, Tailwind config, header
│   ├── app.js             WS client, card renderer, filters
│   └── style.css          Card styles, animations, theme
├── start.bat              Windows quick-launch
├── package.json
├── package-lock.json
├── .gitignore
└── README.md
```

### Data flow per session

1. Claude Code writes a new line to `~/.claude/projects/<dir>/<uuid>.jsonl`
2. `chokidar` fires a `change` event
3. After a 400ms debounce, `loadSession()` parses the changed file
4. An aggregated session object is broadcast on the WebSocket as `session-update`
5. Each browser client updates the matching card and flashes it green

### What gets aggregated

Per session, the parser walks every JSONL line and accumulates:

- **Identity:** sessionId, cwd, project name, git branch, generated title
- **Model:** latest `message.model` value
- **Tokens:** input + output + cache (read + create), summed across all assistant messages
- **Tools:** every `tool_use` content block — name histogram + chronological history
- **Status:** derived from time-since-last-activity and pending tool calls
- **Messages:** user vs assistant counts

---

## License

MIT — use freely.
