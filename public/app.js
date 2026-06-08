const grid = document.getElementById('grid');
const emptyEl = document.getElementById('empty');
const connDot = document.getElementById('conn-dot');
const connText = document.getElementById('conn-text');
const lastUpdateEl = document.getElementById('last-update');
const countActive = document.getElementById('count-active');
const countWaiting = document.getElementById('count-waiting');
const countIdle = document.getElementById('count-idle');
const countTotal = document.getElementById('count-total');
const filterButtons = document.querySelectorAll('.filter-btn');

let sessions = new Map();
let currentFilter = 'all';

filterButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    currentFilter = btn.dataset.filter;
    filterButtons.forEach((b) => {
      const active = b.dataset.filter === currentFilter;
      b.dataset.active = String(active);
      if (active) {
        b.classList.add('bg-accent', 'text-ink-950', 'font-medium');
        b.classList.remove('bg-ink-800');
      } else {
        b.classList.remove('bg-accent', 'text-ink-950', 'font-medium');
        b.classList.add('bg-ink-800');
      }
    });
    render();
  });
});

document.querySelector('.filter-btn[data-filter="all"]').dataset.active = 'true';

function fmtAge(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function fmtDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

function fmtTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function shortModel(model) {
  if (!model || model === 'unknown') return '—';
  return model.replace(/^claude-/, '').replace(/-(\d{8})$/, '');
}

function sparklineBars(history) {
  if (!history || history.length === 0) {
    return '<div class="text-[10px] muted-text">no tools yet</div>';
  }
  const buckets = 24;
  const now = Date.now();
  const oldest = new Date(history[0].t).getTime();
  const span = Math.max(now - oldest, 60_000);
  const counts = new Array(buckets).fill(0);
  for (const tool of history) {
    const ts = new Date(tool.t).getTime();
    const ratio = (ts - oldest) / span;
    const idx = Math.min(buckets - 1, Math.floor(ratio * buckets));
    counts[idx] += 1;
  }
  const max = Math.max(...counts, 1);
  return counts
    .map((c) => {
      const h = c === 0 ? 3 : 6 + Math.round((c / max) * 22);
      const opacity = c === 0 ? 0.15 : 0.5 + 0.5 * (c / max);
      return `<div class="bar" style="height:${h}px;background:#7ab648;opacity:${opacity}"></div>`;
    })
    .join('');
}

function topTools(toolUsage, limit = 4) {
  const entries = Object.entries(toolUsage || {});
  entries.sort((a, b) => b[1] - a[1]);
  return entries.slice(0, limit);
}

function renderCard(s) {
  const status = s.status || 'idle';
  const subagent = s.currentTool === 'Task' ? '↳ subagent' : '';
  const title = s.title || `session ${s.sessionId.slice(0, 8)}`;
  const branch = s.gitBranch ? `<span class="muted-text font-mono text-[11px]">${escapeHtml(s.gitBranch)}</span>` : '';
  const tools = topTools(s.toolUsage, 4)
    .map(
      ([name, count]) =>
        `<span class="tool-pill">${escapeHtml(name)} <span class="count">${count}</span></span>`,
    )
    .join('');

  return `
    <article class="card status-${status}" data-session="${s.sessionId}">
      <div class="updating-flash"></div>
      <div class="flex items-start justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0 flex-1">
          <span class="status-dot ${status}" title="${status}"></span>
          <h2 class="font-semibold text-sm truncate" title="${escapeHtml(s.projectName)}">${escapeHtml(s.projectName)}</h2>
        </div>
        <span class="text-[10px] font-mono muted-text uppercase tracking-wide">${status}</span>
      </div>

      <p class="text-xs muted-text mt-1 line-clamp-2" title="${escapeHtml(title)}">${escapeHtml(title)}</p>

      <div class="flex items-center gap-3 mt-3 text-[11px] font-mono muted-text">
        <span title="model">${shortModel(s.model)}</span>
        <span>·</span>
        <span title="duration">${fmtDuration(s.durationSeconds)}</span>
        <span>·</span>
        <span title="last activity" class="${status === 'active' ? 'text-accent' : ''}">${fmtAge(s.ageSeconds)} ago</span>
        ${branch ? `<span>·</span>${branch}` : ''}
      </div>

      <div class="grid grid-cols-3 gap-2 mt-3 text-center">
        <div class="bg-ink-900 rounded-md py-2">
          <div class="text-[10px] muted-text uppercase tracking-wider">tokens</div>
          <div class="text-sm font-mono font-medium">${fmtTokens(s.tokens.total)}</div>
        </div>
        <div class="bg-ink-900 rounded-md py-2">
          <div class="text-[10px] muted-text uppercase tracking-wider">tools</div>
          <div class="text-sm font-mono font-medium">${s.toolCount}</div>
        </div>
        <div class="bg-ink-900 rounded-md py-2">
          <div class="text-[10px] muted-text uppercase tracking-wider">msgs</div>
          <div class="text-sm font-mono font-medium">${s.userMessageCount}/${s.assistantMessageCount}</div>
        </div>
      </div>

      ${s.currentTool ? `
        <div class="mt-3 text-xs">
          <span class="muted-text">current:</span>
          <span class="font-mono text-accent">${escapeHtml(s.currentTool)}</span>
          ${subagent ? `<span class="muted-text ml-1">${subagent}</span>` : ''}
        </div>` : ''}

      ${tools ? `<div class="flex flex-wrap gap-1.5 mt-3">${tools}</div>` : ''}

      <div class="sparkline" title="tool usage over time">
        ${sparklineBars(s.toolHistory)}
      </div>

      <div class="mt-3 text-[10px] font-mono muted-text truncate" title="${escapeHtml(s.sessionId)}">
        ${s.sessionId.slice(0, 8)}…${s.sessionId.slice(-4)}
      </div>
    </article>
  `;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusOrder(status) {
  switch (status) {
    case 'active': return 0;
    case 'waiting': return 1;
    case 'recent': return 2;
    case 'idle': return 3;
    default: return 4;
  }
}

function matchesFilter(session) {
  if (currentFilter === 'all') return true;
  if (currentFilter === 'idle') {
    return session.status === 'idle' || session.status === 'recent';
  }
  return session.status === currentFilter;
}

function render() {
  const all = Array.from(sessions.values());
  all.sort((a, b) => {
    const so = statusOrder(a.status) - statusOrder(b.status);
    if (so !== 0) return so;
    return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
  });

  const visible = all.filter(matchesFilter);

  if (visible.length === 0) {
    grid.innerHTML = '';
    emptyEl.classList.remove('hidden');
  } else {
    emptyEl.classList.add('hidden');
    grid.innerHTML = visible.map(renderCard).join('');
  }

  let active = 0, waiting = 0, idle = 0;
  for (const s of all) {
    if (s.status === 'active') active += 1;
    else if (s.status === 'waiting') waiting += 1;
    else idle += 1;
  }
  countActive.textContent = active;
  countWaiting.textContent = waiting;
  countIdle.textContent = idle;
  countTotal.textContent = all.length;
  lastUpdateEl.textContent = new Date().toLocaleTimeString('lv-LV');
}

function flashCard(sessionId) {
  const el = grid.querySelector(`[data-session="${sessionId}"]`);
  if (!el) return;
  el.classList.remove('just-updated');
  void el.offsetWidth;
  el.classList.add('just-updated');
}

function connect() {
  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const ws = new WebSocket(wsUrl);

  ws.addEventListener('open', () => {
    connDot.className = 'w-2 h-2 rounded-full bg-accent';
    connText.textContent = 'connected';
  });

  ws.addEventListener('close', () => {
    connDot.className = 'w-2 h-2 rounded-full bg-alert animate-pulse';
    connText.textContent = 'disconnected — retrying…';
    setTimeout(connect, 1500);
  });

  ws.addEventListener('error', () => {
    connText.textContent = 'connection error';
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === 'snapshot') {
      sessions = new Map(msg.sessions.map((s) => [s.sessionId, s]));
      render();
    } else if (msg.type === 'session-update') {
      sessions.set(msg.session.sessionId, msg.session);
      render();
      flashCard(msg.session.sessionId);
    }
  });
}

connect();
