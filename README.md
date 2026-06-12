# Agents Dashboard

Local real-time dashboard for monitoring Claude Code sessions and subagents — a passive read-only observer over `~/.claude/projects/` JSONL files.

Works for anyone running Claude Code locally; no organization-specific assumptions.

![status](https://img.shields.io/badge/status-MVP-7AB648)
![node](https://img.shields.io/badge/node-%3E%3D18-7AB648)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-7AB648)

---

## Table of Contents

1. [What it does](#what-it-does)
2. [Where Claude Code reads things from](#where-claude-code-reads-things-from)
3. [Quick start](#quick-start)
4. [Install on a different PC](#install-on-a-different-pc)
5. [How to launch the server](#how-to-launch-the-server)
6. [Auto-start on boot](#auto-start-on-boot)
7. [Configuration](#configuration)
8. [Troubleshooting](#troubleshooting)
9. [Architecture](#architecture)

---

## What it does

- Watches every Claude Code session JSONL file in real time
- Renders one card per session: status, model, tokens, tool usage, current tool, cost estimate, live burn rate (tok/min), and recent tool chain
- Token-usage chart with tabbed range toggle: **hours** (last 24h with live current-hour pulse) · **days** (last 7d) · **weeks** (last 4w) · **months** (last 6m)
- Discovers and lists installed skills and subagents — both global and project-scoped
- Live updates via WebSocket — no manual refresh needed
- 100% passive: does not modify any agent, skill, MCP server, or setting

---

## Where Claude Code reads things from

The dashboard mirrors Claude Code's own conventions. There are **two scopes**:

```
~/.claude/                                  ← user-global (always available)
├── projects/<project-hash>/<uuid>.jsonl     ← session data the dashboard reads
├── agents/<domain>/<agent>.md               ← global subagents
└── skills/<skill>/SKILL.md                  ← global skills (slash commands)

<your-project>/.claude/                     ← project-scoped (only when cwd matches)
├── agents/<domain>/<agent>.md               ← project subagents
└── skills/<skill>/SKILL.md                  ← project skills
```

- **Session JSONLs** (`~/.claude/projects/`) are the dashboard's primary data source — every live card, token chart, and cost figure is derived from these files.
- **Global skills/agents** are listed under the `▸ skills` and `▸ agents` tabs as-is.
- **Project-scoped skills/agents** show up under the `▸ projects` tab, grouped by project. For this to work, set `PROJECTS_ROOT` to the folder where your code lives (default: `~/Projects`) — see [Projects tab](#projects-tab) below.

Nothing is written to these locations — the dashboard is read-only.

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

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4173` | HTTP/WebSocket port the server binds to |
| `HOST` | `127.0.0.1` | Bind address. Set to `0.0.0.0` only if you intentionally want LAN access (there is no auth) |
| `PROJECTS_ROOT` | `~/Projects` | Root folder where the dashboard looks for per-project `.claude/skills/` and `.claude/agents/`. Override if your code lives elsewhere — see [Projects tab](#projects-tab) below |
| `PROJECTS_SCAN_DEPTH` | `6` | How many folders deep to recurse under `PROJECTS_ROOT` looking for `.claude/` directories |

Examples:

```bash
# macOS / Linux — code lives in ~/Code
PROJECTS_ROOT=~/Code npm start

# Windows PowerShell — code lives in D:\repos
$env:PROJECTS_ROOT = "D:\repos"; npm start

# Allow LAN access on a custom port (be aware: no auth)
HOST=0.0.0.0 PORT=8080 npm start
```

### Projects tab

The dashboard distinguishes three kinds of skills/agents:

- **Global skills** in `~/.claude/skills/` — available from any project
- **Global subagents** in `~/.claude/agents/<domain>/` — available from any project
- **Project-scoped** in `<your-project>/.claude/skills/` and `<your-project>/.claude/agents/` — only active when Claude Code is running from that folder

The `▸ projects` tab in the dashboard lists the third group, grouped by project. **For it to find your project-scoped files**, the dashboard needs to know where your code lives. The default `~/Projects/` works for some setups but not all — set `PROJECTS_ROOT` to your actual code root (e.g. `~/Code`, `~/dev`, `~/Documents/GitHub`, `D:\repos`).

If `PROJECTS_ROOT` doesn't exist or has no `.claude/` folders, the tab will simply be empty — there is no error.

### Tuning constants

These are constants in the source files (not env vars). Edit and restart to change:

| Setting | File | Default | Description |
|---|---|---|---|
| `LIVE_WINDOW_MS` | `lib/sessions.js` | `2 min` | How recent counts as "live" |
| `PAUSED_WINDOW_MS` | `lib/sessions.js` | `30 min` | "Paused" vs "idle" threshold; also hides anything older than this |
| `TOOL_HISTORY_LIMIT` | `lib/sessions.js` | `50` | Max tool events kept per card |
| `PERIODIC_REFRESH_MS` | `server.js` | `5000` | Periodic full re-scan interval |
| `REFRESH_DEBOUNCE_MS` | `server.js` | `400` | Debounce window for file events |
| `USAGE_LOOKBACK_DAYS` | `lib/registry.js` | `35` | How many days back to scan for skill/agent usage stats |

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
┌──────────────────────────────────────────────────────────────┐
│  Claude Code CLI                                             │
│  └─ writes JSONL → ~/.claude/projects/<project>/<uuid>.jsonl │
└──────────────────────────┬───────────────────────────────────┘
                           │ file events (chokidar)
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  server.js  (Node.js + Express + ws + chokidar)              │
│  ├─ lib/sessions.js  parse JSONL → session objects           │
│  │                   adds costUsd + tokensLast5Min           │
│  ├─ lib/stats.js     aggregate tokens → 24h/7d/4w/6m         │
│  ├─ lib/pricing.js   Anthropic model pricing → cost          │
│  ├─ lib/registry.js  read .claude/skills + .claude/agents    │
│  └─ ws broadcasts snapshots every 5 s + on file change       │
└──────────────────────────┬───────────────────────────────────┘
                           │ HTTP + WS on :4173 (localhost)
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  Browser  (vanilla JS, no framework)                         │
│  ├─ public/index.html  layout + chart range tabs             │
│  ├─ public/app.js      WS client + card renderer + toggle    │
│  └─ public/style.css   terminal-style theme + animations     │
└──────────────────────────────────────────────────────────────┘
```

### Project layout

```
agents-dashboard/
├── server.js              Express + WebSocket + chokidar watcher
├── lib/
│   ├── sessions.js        JSONL parser, status logic, cost/burn aggregation
│   ├── stats.js           token aggregation: 24h / days / weeks / months
│   ├── pricing.js         Anthropic model pricing (used for cost estimates)
│   ├── processes.js       OS-level claude process detection
│   ├── registry.js        skill / agent / project library discovery
│   └── utils.js           shared helpers (day keys, project name decoding)
├── public/
│   ├── index.html         layout, header, chart range tabs
│   ├── app.js             WS client, card renderer, chart toggle
│   └── style.css          card styles, animations, chart theme
├── tests/                 node:test suites for the lib/ modules
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
- **Cost (USD):** `tokens × model price` from `lib/pricing.js` (Opus / Sonnet / Haiku, default + 1M-context variants)
- **Burn rate:** tokens consumed in the last 5 minutes, recomputed on every refresh
- **Tools:** every `tool_use` content block — name histogram + chronological history (last 50)
- **Status:** derived from time-since-last-activity and pending tool calls
- **Messages:** user vs assistant counts
- **Subagents / Skills:** every `Task` and `Skill` invocation with timestamps and completion state

Across all sessions, `lib/stats.js` rolls things up into hourly / daily / weekly / monthly token buckets that feed the token-statistics panel.

---

## License

MIT — use freely.
