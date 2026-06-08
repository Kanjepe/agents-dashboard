const grid = document.getElementById('grid');
const emptyEl = document.getElementById('empty');
const connDot = document.getElementById('conn-dot');
const connText = document.getElementById('conn-text');
const lastUpdateEl = document.getElementById('last-update');
const todayDateEl = document.getElementById('today-date');
const todayTokensEl = document.getElementById('today-tokens');
const countProcesses = document.getElementById('count-processes');
const countLive = document.getElementById('count-live');
const countWaiting = document.getElementById('count-waiting');
const countPaused = document.getElementById('count-paused');
const filterButtons = document.querySelectorAll('.filter');

const statsMetaEl = document.getElementById('stats-meta');
const totalTodayEl = document.getElementById('total-today');
const totalWeekEl = document.getElementById('total-week');
const totalMonthEl = document.getElementById('total-month');
const totalTodayBarEl = document.getElementById('total-today-bar');
const totalWeekBarEl = document.getElementById('total-week-bar');
const totalMonthBarEl = document.getElementById('total-month-bar');
const totalTodayDateEl = document.getElementById('total-today-date');
const totalWeekHintEl = document.getElementById('total-week-hint');
const totalMonthHintEl = document.getElementById('total-month-hint');
const chart7El = document.getElementById('chart7');
const topTodayEl = document.getElementById('top-today');
const topWeekEl = document.getElementById('top-week');
const topMonthEl = document.getElementById('top-month');

let sessions = new Map();
let processes = [];
let stats = null;
let currentFilter = 'live';
const entryEls = new Map();

const statsPanelEl = document.querySelector('.stats-panel');
const entriesEl = document.getElementById('grid');

function applyViewMode() {
  const showStats = currentFilter === 'stats';
  if (statsPanelEl) statsPanelEl.hidden = !showStats;
  if (entriesEl) entriesEl.hidden = showStats;
  if (emptyEl && showStats) emptyEl.hidden = true;
}

const STATUS_LABEL = {
  live: 'live',
  waiting: 'waiting',
  paused: 'paused',
  idle: 'idle',
};

filterButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    currentFilter = btn.dataset.filter;
    filterButtons.forEach((b) => {
      b.dataset.active = String(b.dataset.filter === currentFilter);
    });
    applyViewMode();
    if (currentFilter === 'stats') {
      renderStats();
    } else {
      render();
    }
  });
});

applyViewMode();

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
  return rm === 0 ? `${h}h` : `${h}h${String(rm).padStart(2, '0')}`;
}

function fmtTokens(n) {
  if (n < 1000) return { num: String(n), unit: '' };
  if (n < 1_000_000) return { num: (n / 1000).toFixed(1), unit: 'k' };
  return { num: (n / 1_000_000).toFixed(2), unit: 'M' };
}

function fmtTokensCompact(n) {
  const t = fmtTokens(n);
  return `${t.num}${t.unit}`;
}

function fmtDateLong(iso) {
  if (!iso) return '----.--.--';
  const [y, m, d] = iso.split('-');
  return `${y}.${m}.${d}`;
}

function fmtDateShort(iso) {
  if (!iso) return '--';
  return iso.slice(5);
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function weekdayShort(iso) {
  const d = new Date(`${iso}T00:00:00`);
  return WEEKDAYS[d.getDay()];
}

function shortModel(model) {
  if (!model || model === 'unknown') return '—';
  const trimmed = model.replace(/^claude-/, '').replace(/-(\d{8})$/, '');
  return trimmed.replace(/-/g, ' ');
}

function sparklineBars(history) {
  if (!history || history.length === 0) {
    return Array(24).fill('<div class="bar bar--empty" style="height:3px"></div>').join('');
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
      if (c === 0) return '<div class="bar bar--empty" style="height:3px"></div>';
      const h = 6 + Math.round((c / max) * 24);
      const opacity = 0.45 + 0.55 * (c / max);
      return `<div class="bar" style="height:${h}px;opacity:${opacity.toFixed(2)}"></div>`;
    })
    .join('');
}

function topTools(toolUsage, limit = 5) {
  const entries = Object.entries(toolUsage || {});
  entries.sort((a, b) => b[1] - a[1]);
  return entries.slice(0, limit);
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
    case 'live': return 0;
    case 'waiting': return 1;
    case 'paused': return 2;
    case 'idle': return 3;
    default: return 4;
  }
}

function matchesFilter(session) {
  if (currentFilter === 'all') return true;
  return session.status === currentFilter;
}

function renderEntry(s, index) {
  const status = s.status || 'idle';
  const num = String(index + 1).padStart(2, '0');
  const statusLabel = STATUS_LABEL[status] || status;
  const subagent = s.currentTool === 'Task';
  const tokens = fmtTokens(s.tokens.total);

  const metaParts = [
    `<strong>${escapeHtml(shortModel(s.model))}</strong>`,
    fmtDuration(s.durationSeconds),
  ];
  if (s.gitBranch) metaParts.push(escapeHtml(s.gitBranch));

  const pills = topTools(s.toolUsage, 4)
    .map(([name, count]) => `<span class="pill">${escapeHtml(name)}:<em>${count}</em></span>`)
    .join('');

  const safeSid = escapeHtml(s.sessionId);
  const sidShort = `${escapeHtml(s.sessionId.slice(0, 8))}..${escapeHtml(s.sessionId.slice(-4))}`;

  const currentLine = s.currentTool
    ? `<p class="entry__current">${subagent ? 'spawning' : 'now'} <strong>${escapeHtml(s.currentTool)}</strong></p>`
    : '';

  return `
    <article class="entry" data-status="${status}" data-session="${safeSid}">
      <header class="entry__head">
        <span class="entry__id">[${num}]</span>
        <span class="entry__status">
          <span class="entry__dot" aria-hidden="true"></span>
          <span class="entry__statuslabel">${statusLabel}</span>
        </span>
        <time class="entry__time">${fmtAge(s.ageSeconds)} ago</time>
      </header>

      <div class="entry__body">
        <h2 class="entry__title">${escapeHtml(s.projectName)}</h2>
        ${s.title ? `<p class="entry__subtitle">${escapeHtml(s.title)}</p>` : ''}

        <div class="entry__meta">
          ${metaParts.join('<span class="sep">·</span>')}
        </div>

        <div class="entry__stats" aria-label="Session statistics">
          <div class="stat-cell">
            <span class="stat-cell__num">${tokens.num}<span class="stat-cell__unit">${tokens.unit}</span></span>
            <span class="stat-cell__label">tokens</span>
          </div>
          <div class="stat-cell">
            <span class="stat-cell__num">${s.toolCount}</span>
            <span class="stat-cell__label">actions</span>
          </div>
          <div class="stat-cell">
            <span class="stat-cell__num">${s.userMessageCount}<span class="stat-cell__unit">/${s.assistantMessageCount}</span></span>
            <span class="stat-cell__label">msgs</span>
          </div>
        </div>

        ${currentLine}

        <div class="entry__pulse" aria-label="Tool activity">
          ${sparklineBars(s.toolHistory)}
        </div>

        <footer class="entry__foot">
          ${pills ? `<span class="entry__pills">${pills}</span>` : '<span></span>'}
          <code class="entry__hash">${sidShort}</code>
        </footer>
      </div>
    </article>
  `;
}

function sessionSignature(s) {
  return [
    s.status,
    s.title || '',
    s.projectName || '',
    s.gitBranch || '',
    s.model || '',
    s.currentTool || '',
    s.toolCount || 0,
    s.tokens?.total || 0,
    s.userMessageCount || 0,
    s.assistantMessageCount || 0,
    s.durationSeconds || 0,
    s.toolHistory?.length || 0,
    Object.keys(s.toolUsage || {}).sort().join(','),
  ].join('|');
}

function htmlToElement(html) {
  const tmp = document.createElement('template');
  tmp.innerHTML = html.trim();
  return tmp.content.firstElementChild;
}

function updateTimeOnly(el, s) {
  const timeEl = el.querySelector('.entry__time');
  if (timeEl) {
    const txt = `${fmtAge(s.ageSeconds)} ago`;
    if (timeEl.textContent !== txt) timeEl.textContent = txt;
  }
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
    for (const el of entryEls.values()) el.remove();
    entryEls.clear();
    emptyEl.hidden = currentFilter === 'stats';
  } else {
    emptyEl.hidden = true;
    const visibleIds = new Set(visible.map((s) => s.sessionId));

    for (const [sid, el] of entryEls) {
      if (!visibleIds.has(sid)) {
        el.remove();
        entryEls.delete(sid);
      }
    }

    visible.forEach((s, i) => {
      let el = entryEls.get(s.sessionId);
      const sig = sessionSignature(s);

      if (!el) {
        el = htmlToElement(renderEntry(s, i));
        el.dataset.sig = sig;
        entryEls.set(s.sessionId, el);
      } else if (el.dataset.sig !== sig) {
        const fresh = htmlToElement(renderEntry(s, i));
        el.dataset.status = s.status;
        el.dataset.sig = sig;
        el.innerHTML = fresh.innerHTML;
      } else {
        updateTimeOnly(el, s);
      }
    });

    visible.forEach((s, i) => {
      const el = entryEls.get(s.sessionId);
      if (grid.children[i] !== el) {
        grid.insertBefore(el, grid.children[i] || null);
      }
    });
  }

  let live = 0, waiting = 0, paused = 0;
  for (const s of all) {
    if (s.status === 'live') live += 1;
    else if (s.status === 'waiting') waiting += 1;
    else if (s.status === 'paused') paused += 1;
  }
  countLive.textContent = live;
  countWaiting.textContent = waiting;
  countPaused.textContent = paused;
  countProcesses.textContent = processes.length;

  const now = new Date();
  lastUpdateEl.textContent = now.toLocaleTimeString('en-GB', { hour12: false });
}

function renderStats() {
  if (!stats) return;

  todayDateEl.textContent = fmtDateLong(stats.todayDate);
  todayTokensEl.textContent = fmtTokensCompact(stats.today);

  totalTodayEl.textContent = fmtTokensCompact(stats.today);
  totalWeekEl.textContent = fmtTokensCompact(stats.week);
  totalMonthEl.textContent = fmtTokensCompact(stats.month);

  totalTodayDateEl.textContent = stats.todayDate || '';
  totalWeekHintEl.textContent = `from ${stats.weekStart}`;
  totalMonthHintEl.textContent = `from ${stats.monthStart}`;

  const monthBase = Math.max(stats.month, 1);
  const todayPct = Math.min(100, (stats.today / monthBase) * 100);
  const weekPct = Math.min(100, (stats.week / monthBase) * 100);
  totalTodayBarEl.style.width = `${todayPct.toFixed(1)}%`;
  totalWeekBarEl.style.width = `${weekPct.toFixed(1)}%`;
  totalMonthBarEl.style.width = `100%`;

  if (statsMetaEl) {
    statsMetaEl.textContent = `${stats.fileCount} files scanned`;
  }

  renderChart7();
  renderTop(topTodayEl, stats.topToday);
  renderTop(topWeekEl, stats.topWeek);
  renderTop(topMonthEl, stats.topMonth);
}

function renderChart7() {
  if (!stats || !chart7El) return;
  const days = stats.last7Days || [];
  if (days.length === 0) {
    chart7El.innerHTML = '<div class="top__empty">no data yet</div>';
    return;
  }
  const max = Math.max(...days.map((d) => d.tokens), 1);
  chart7El.innerHTML = days
    .map((d) => {
      const heightPct = d.tokens === 0 ? 0 : Math.max(2, (d.tokens / max) * 100);
      const isToday = d.date === stats.todayDate;
      const barClass = [
        'chart7__bar',
        d.tokens === 0 ? 'chart7__bar--zero' : '',
        isToday ? 'chart7__bar--today' : '',
      ]
        .filter(Boolean)
        .join(' ');
      return `
        <div class="chart7__day">
          <span class="${barClass}" style="height:${heightPct.toFixed(1)}%"></span>
          <span class="chart7__val">${fmtTokensCompact(d.tokens)}</span>
          <span class="chart7__label ${isToday ? 'chart7__label--today' : ''}">${weekdayShort(d.date)}</span>
        </div>
      `;
    })
    .join('');
}

function renderTop(el, list) {
  if (!el) return;
  if (!list || list.length === 0) {
    el.innerHTML = '<li class="top__empty">// no entries</li>';
    return;
  }
  const max = list[0].tokens || 1;
  el.innerHTML = list
    .map((p, i) => {
      const rank = String(i + 1).padStart(2, '0');
      const widthPct = Math.max(2, (p.tokens / max) * 100);
      return `
        <li class="top__item">
          <span class="top__rank">${rank}</span>
          <span class="top__name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
          <span class="top__tokens">${fmtTokensCompact(p.tokens)}</span>
          <span class="top__bar"><span style="width:${widthPct.toFixed(1)}%"></span></span>
        </li>
      `;
    })
    .join('');
}

function flashEntry(sessionId) {
  const el = grid.querySelector(`[data-session="${CSS.escape(sessionId)}"]`);
  if (!el) return;
  el.classList.remove('just-updated');
  void el.offsetWidth;
  el.classList.add('just-updated');
}

function connect() {
  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const ws = new WebSocket(wsUrl);

  ws.addEventListener('open', () => {
    connDot.dataset.state = 'connected';
    connText.textContent = 'connected';
  });

  ws.addEventListener('close', () => {
    connDot.dataset.state = 'disconnected';
    connText.textContent = 'reconnecting';
    setTimeout(connect, 1500);
  });

  ws.addEventListener('error', () => {
    connDot.dataset.state = 'disconnected';
    connText.textContent = 'error';
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === 'snapshot') {
      sessions = new Map((msg.sessions || []).map((s) => [s.sessionId, s]));
      processes = msg.processes || [];
      if (msg.stats) stats = msg.stats;
      render();
      renderStats();
    } else if (msg.type === 'session-update') {
      sessions.set(msg.session.sessionId, msg.session);
      render();
      flashEntry(msg.session.sessionId);
    }
  });
}

connect();
