# AI Session Telemetry

Local, real-time telemetry for AI coding sessions, agents, skills and cost — a passive, read-only observer over Claude Code and Codex CLI JSONL files.

Works for anyone running Claude Code, Codex CLI, or both locally; no organization-specific assumptions.

![status](https://img.shields.io/badge/status-MVP-7AB648)
![node](https://img.shields.io/badge/node-%3E%3D18-7AB648)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-7AB648)

---

## Table of Contents

1. [What it does](#what-it-does)
2. [Where telemetry data comes from](#where-telemetry-data-comes-from)
3. [Quick start](#quick-start)
4. [Install on a different PC](#install-on-a-different-pc)
5. [How to launch the server](#how-to-launch-the-server)
6. [Auto-start on boot](#auto-start-on-boot)
7. [Configuration](#configuration)
8. [Troubleshooting](#troubleshooting)
9. [Architecture](#architecture)

---

## What it does

- Watches Claude Code and Codex CLI session JSONL files in real time
- Renders one provider-labeled live card per Claude or Codex session: status, model, tokens, tool usage, current tool, cost estimate, live burn rate (tok/min), and recent tool chain
- Filters live sessions by `all | claude | codex` without mixing provider identities
- Provides separate `claude | codex` statistics views with provider-specific model pricing and cost totals
- Token-usage chart with tabbed range toggle: **hours** (last 24h with live current-hour pulse) · **days** (last 7d) · **weeks** (last 4w) · **months** (last 6m)
- Discovers and lists installed skills and subagents — both global and project-scoped
- Live updates via WebSocket — no manual refresh needed
- 100% passive: does not modify any agent, skill, MCP server, or setting

---

## Where telemetry data comes from

The dashboard reads both providers' local files. Claude Code also has global and project scopes for skills and agents:

```
~/.claude/                                  ← user-global (always available)
├── projects/<project-hash>/<uuid>.jsonl     ← session data the dashboard reads
├── agents/<domain>/<agent>.md               ← global subagents
└── skills/<skill>/SKILL.md                  ← global skills (slash commands)

<your-project>/.claude/                     ← project-scoped (only when cwd matches)
├── agents/<domain>/<agent>.md               ← project subagents
└── skills/<skill>/SKILL.md                  ← project skills

~/.codex/
└── sessions/YYYY/MM/DD/rollout-*.jsonl      ← Codex CLI live session and statistics source
```

- **Claude session JSONLs** (`~/.claude/projects/`) drive provider-labeled live cards and the Claude statistics view.
- **Codex rollout JSONLs** (`~/.codex/sessions/`) drive provider-labeled live cards and the Codex statistics view.
- **Global skills/agents** are listed under the `▸ skills` and `▸ agents` tabs as-is.
- **Project-scoped skills/agents** show up under the `▸ projects` tab, grouped by project. For this to work, set `PROJECTS_ROOT` to the folder where your code lives (default: `~/Projects`) — see [Projects tab](#projects-tab) below.

Nothing is written to these locations — the dashboard is read-only.

---

## Quick start

Requirements: **Node.js 18 or newer** and at least one local Claude Code or Codex CLI session directory.

```bash
git clone https://github.com/Kanjepe/ai-session-telemetry.git
cd ai-session-telemetry
npm install
npm start
```

Then open <http://localhost:4173> in any browser.

On Windows you can also double-click `start.bat` after the first `npm install` — it starts the server and opens the browser automatically.

To stop the server: press `Ctrl+C` in the terminal.

> The dashboard reads from `~/.claude/projects/` and `~/.codex/sessions/` on the machine it runs on. It does not connect to anything remote. Run it on the same PC as the CLI providers you want to observe.

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

Copy the entire `ai-session-telemetry/` folder to the new PC, anywhere you like. **Skip `node_modules/`** — it will be regenerated. The folder you need contains:

```
ai-session-telemetry/
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
git clone <your-repo-url> ai-session-telemetry
cd ai-session-telemetry
```

**Option C — Zip + transfer**

```powershell
# On source PC (run from the folder ABOVE ai-session-telemetry):
Compress-Archive -Path ".\ai-session-telemetry" `
                 -DestinationPath "ai-session-telemetry.zip" `
                 -Exclude "node_modules"

# Then transfer the zip and extract on the target PC.
```

### Step 3 — Install dependencies

```bash
cd path/to/ai-session-telemetry
npm install
```

This downloads `express`, `ws`, and `chokidar` into a local `node_modules/` folder (~3 MB).

### Step 4 — Launch

```bash
npm start
```

Then open <http://localhost:4173> in any browser.

> **Important:** the dashboard reads from `~/.claude/projects/` and `~/.codex/sessions/` on the **machine it runs on**. It does not connect to remote machines.

---

## How to launch the server

### Method 1 — Double-click `start.bat` (Windows, easiest)

Auto-installs dependencies on first run, starts the server, and opens the browser. Closing the terminal window stops the server.

### Method 2 — From the terminal (cross-platform)

```bash
cd path/to/ai-session-telemetry
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
cd C:\path\to\ai-session-telemetry
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
cd path/to/ai-session-telemetry
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
3. Target: `C:\path\to\ai-session-telemetry\start.bat`
4. Click Next → name it "AI Session Telemetry" → Finish

The dashboard now starts whenever you log in.

### Windows — Task Scheduler (advanced)

For headless start without opening a terminal:

1. Open Task Scheduler → Create Basic Task
2. Trigger: "When I log on"
3. Action: Start a program
   - Program: `node`
   - Arguments: `server.js`
   - Start in: `C:\path\to\ai-session-telemetry`
4. Finish

### Windows — Run as a Service (advanced)

Use [NSSM](https://nssm.cc/) to run as a true Windows service:

```powershell
nssm install AiSessionTelemetry "C:\Program Files\nodejs\node.exe" "C:\path\to\ai-session-telemetry\server.js"
nssm start AiSessionTelemetry
```

### macOS — launchd

Create `~/Library/LaunchAgents/ai-session-telemetry.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>com.ai-session-telemetry</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/ai-session-telemetry/server.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>/path/to/ai-session-telemetry</string>
</dict>
</plist>
```

Then:

```bash
launchctl load ~/Library/LaunchAgents/ai-session-telemetry.plist
```

### Linux — systemd

Create `/etc/systemd/system/ai-session-telemetry.service`:

```ini
[Unit]
Description=AI Session Telemetry
After=network.target

[Service]
Type=simple
User=YOUR_USERNAME
WorkingDirectory=/home/YOUR_USERNAME/ai-session-telemetry
ExecStart=/usr/bin/node server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl enable ai-session-telemetry
sudo systemctl start ai-session-telemetry
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

### "No sessions or statistics appear"

The dashboard reads Claude sessions from `~/.claude/projects/` and Codex sessions from `~/.codex/sessions/`. If a provider's folder does not exist, run that CLI once, then refresh the dashboard.

Verify:

```powershell
# Windows
Test-Path "$env:USERPROFILE\.claude\projects"
Test-Path "$env:USERPROFILE\.codex\sessions"
```

```bash
# macOS / Linux
ls ~/.claude/projects
ls ~/.codex/sessions
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

`chokidar` falls back to polling on some network drives. If a provider directory lives on a synced drive (OneDrive, Dropbox), watch events may be delayed. The periodic 5-second snapshot acts as a fallback. Live cards are Claude-only; Codex rollout changes update the Codex statistics view.

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
│  Codex CLI                                                   │
│  └─ writes JSONL → ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl│
└──────────────────────────┬───────────────────────────────────┘
                           │ file events (chokidar)
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  server.js  (Node.js + Express + ws + chokidar)              │
│  ├─ lib/sessions.js  parse JSONL → session objects           │
│  │                   adds costUsd + tokensLast5Min           │
│  ├─ lib/stats.js     aggregate tokens → 24h/7d/4w/6m         │
│  ├─ lib/pricing.js   Anthropic model pricing → cost          │
│  ├─ lib/codex.js     parse + aggregate Codex rollouts         │
│  ├─ lib/codex-pricing.js  OpenAI model pricing → cost         │
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
ai-session-telemetry/
├── server.js              Express + WebSocket + chokidar watcher
├── lib/
│   ├── sessions.js        JSONL parser, status logic, cost/burn aggregation
│   ├── stats.js           token aggregation: 24h / days / weeks / months
│   ├── pricing.js         Anthropic model pricing (used for cost estimates)
│   ├── codex.js           Codex rollout parser and statistics adapter
│   ├── codex-pricing.js   OpenAI model pricing for Codex costs
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

For Codex, `lib/codex.js` reads per-turn `last_token_usage`, preserves model switches, applies OpenAI cached-input pricing, and emits the same statistics contract as `lib/stats.js`. The browser switches between the two provider contracts without merging their token semantics.

---

## License

MIT — use freely.
