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
const chart24El = document.getElementById('chart24');
const totalTodayCostEl = document.getElementById('total-today-cost');
const totalWeekCostEl = document.getElementById('total-week-cost');
const totalMonthCostEl = document.getElementById('total-month-cost');
const chartTitleEl = document.getElementById('chart-title');
const chartTabs = document.querySelectorAll('.chart-tab');
let chartRange = 'hours';

chartTabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    chartRange = btn.dataset.range;
    chartTabs.forEach((b) => {
      b.dataset.active = String(b.dataset.range === chartRange);
    });
    renderChart24();
  });
});
const topTodayEl = document.getElementById('top-today');
const topWeekEl = document.getElementById('top-week');
const topMonthEl = document.getElementById('top-month');

let sessions = new Map();
let processes = [];
let stats = null;
let activity = { agents: [], skills: [], timeline: [] };
let registry = { skills: [], agents: [], skillGroups: [], agentDomains: [] };
let agentsSearch = '';
let skillsSearch = '';
let agentsDomain = 'all';
let skillsGroup = 'all';
let currentFilter = 'live';
const entryEls = new Map();
const detailCache = new Map();

let _lastAgentsRenderKey = '';
let _lastSkillsRenderKey = '';

function registryHash(list) {
  if (!list || list.length === 0) return '0';
  let h = `${list.length}`;
  for (const item of list) {
    h += `|${item.slug}:${item.usage?.thisMonth || 0}:${item.usage?.lastUsed || ''}`;
  }
  return h;
}

const SESSION_FILTERS = new Set(['live', 'waiting', 'paused', 'all']);

const statsPanelEl = document.querySelector('.stats-panel');
const entriesEl = document.getElementById('grid');
const agentsViewEl = document.getElementById('agents-view');
const skillsViewEl = document.getElementById('skills-view');
const projectsViewEl = document.getElementById('projects-view');
const activityViewEl = document.getElementById('activity-view');

let projectsSearch = '';
let _lastProjectsRenderKey = '';

function applyViewMode() {
  const isSessions = SESSION_FILTERS.has(currentFilter);
  if (entriesEl) entriesEl.hidden = !isSessions;
  if (agentsViewEl) agentsViewEl.hidden = currentFilter !== 'agents';
  if (skillsViewEl) skillsViewEl.hidden = currentFilter !== 'skills';
  if (projectsViewEl) projectsViewEl.hidden = currentFilter !== 'projects';
  if (activityViewEl) activityViewEl.hidden = currentFilter !== 'activity';
  if (statsPanelEl) statsPanelEl.hidden = currentFilter !== 'stats';
  if (emptyEl && !isSessions) emptyEl.hidden = true;
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
    refreshCurrentView();
  });
});

function refreshCurrentView() {
  if (currentFilter === 'stats') renderStats();
  else if (currentFilter === 'agents') renderAgents();
  else if (currentFilter === 'skills') renderSkills();
  else if (currentFilter === 'projects') renderProjects();
  else if (currentFilter === 'activity') renderActivity();
  else render();
}

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
  if (n < 1_000_000_000) return { num: (n / 1_000_000).toFixed(2), unit: 'M' };
  if (n < 1_000_000_000_000) return { num: (n / 1_000_000_000).toFixed(2), unit: 'B' };
  return { num: (n / 1_000_000_000_000).toFixed(2), unit: 'T' };
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

function fmtCost(usd) {
  if (!usd || usd <= 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  if (usd < 10) return `$${usd.toFixed(2)}`;
  if (usd < 100) return `$${usd.toFixed(1)}`;
  return `$${Math.round(usd)}`;
}

function renderSessionMetrics(s) {
  const cost = fmtCost(s.costUsd || 0);
  const burnTokPerMin = (s.tokensLast5Min || 0) / 5;
  const burnUsdPerMin = (s.costLast5Min || 0) / 5;
  const burn = fmtTokens(Math.round(burnTokPerMin));
  let burnClass = 'metric--idle';
  if (burnTokPerMin > 50000) burnClass = 'metric--hot';
  else if (burnTokPerMin > 10000) burnClass = 'metric--fast';
  else if (burnTokPerMin > 1000) burnClass = 'metric--normal';
  const burnStr = burnTokPerMin > 0
    ? `${burn.num}${burn.unit}/min <span class="metric__usd">≈ ${fmtCost(burnUsdPerMin)}/min</span>`
    : 'idle';
  return `
    <div class="entry__metrics" aria-label="Session metrics">
      <span class="metric metric--cost">
        <span class="metric__label">cost</span>
        <span class="metric__val">${cost}<span class="metric__sub">total</span></span>
      </span>
      <span class="metric ${burnClass}">
        <span class="metric__label">burn</span>
        <span class="metric__val">${burnStr}</span>
      </span>
    </div>
  `;
}

const CHAIN_LIMIT = 6;
function renderToolChain(history) {
  if (!history || history.length === 0) {
    return '<p class="entry__chain entry__chain--empty">no tool activity yet</p>';
  }
  const last = history.slice(-CHAIN_LIMIT);
  const names = last.map((t) => `<span class="chain__tool">${escapeHtml(t.name)}</span>`);
  const joined = names.join('<span class="chain__arrow">→</span>');
  const lastT = new Date(history[history.length - 1].t).getTime();
  const ageSec = Math.max(0, Math.floor((Date.now() - lastT) / 1000));
  return `
    <p class="entry__chain" aria-label="Recent tool activity">
      <span class="chain__label">recent:</span> ${joined}
      <span class="chain__sep">·</span>
      <span class="chain__age">${fmtAge(ageSec)} ago</span>
    </p>
  `;
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

const RECENT_SKILL_WINDOW_MS = 60 * 1000;

function liveWorkItems() {
  if (currentFilter !== 'live' && currentFilter !== 'all') return [];
  const items = [];
  const tl = activity?.timeline || [];
  const now = Date.now();
  for (const ev of tl) {
    const ts = new Date(ev.timestamp).getTime();
    if (ev.kind === 'agent' && !ev.completed) {
      items.push({ kind: 'agent', ev, ts });
    } else if (ev.kind === 'skill' && now - ts < RECENT_SKILL_WINDOW_MS) {
      items.push({ kind: 'skill', ev, ts });
    }
  }
  return items;
}

function renderLiveCard(item) {
  const ev = item.ev;
  const ageSec = Math.max(0, Math.floor((Date.now() - item.ts) / 1000));
  if (item.kind === 'agent') {
    const desc = ev.description ? `<p class="live-card__desc">${escapeHtml(ev.description)}</p>` : '';
    return `
      <article class="live-card live-card--agent" data-kind="agent">
        <header class="live-card__head">
          <span class="live-card__kind">[ subagent ]</span>
          <span class="live-card__status">
            <span class="live-card__dot" aria-hidden="true"></span>
            running
          </span>
          <span class="live-card__time">${fmtAge(ageSec)} ago</span>
        </header>
        <div class="live-card__body">
          <h3 class="live-card__title">${escapeHtml(ev.name)}</h3>
          ${desc}
          <p class="live-card__parent">↪ from: <strong>${escapeHtml(ev.projectName)}</strong></p>
        </div>
      </article>
    `;
  }
  return `
    <article class="live-card live-card--skill" data-kind="skill">
      <header class="live-card__head">
        <span class="live-card__kind">[ skill ]</span>
        <span class="live-card__status">
          <span class="live-card__dot" aria-hidden="true"></span>
          just invoked
        </span>
        <span class="live-card__time">${fmtAge(ageSec)} ago</span>
      </header>
      <div class="live-card__body">
        <h3 class="live-card__title">${escapeHtml(ev.name)}</h3>
        <p class="live-card__parent">↪ from: <strong>${escapeHtml(ev.projectName)}</strong></p>
      </div>
    </article>
  `;
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

  let currentLine = '';
  if (s.currentTool) {
    const verb = subagent ? 'spawning' : s.currentTool === 'Skill' ? 'invoking skill' : 'now';
    const detail = s.currentToolDetail
      ? `${escapeHtml(s.currentTool)} <span class="entry__arrow">→</span> <strong>${escapeHtml(s.currentToolDetail)}</strong>`
      : `<strong>${escapeHtml(s.currentTool)}</strong>`;
    currentLine = `<p class="entry__current">${verb} ${detail}</p>`;
  }

  const metricsLine = renderSessionMetrics(s);
  const toolChain = renderToolChain(s.toolHistory);

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
        <h2 class="entry__title">
          ${s.isObserver
            ? `<span class="entry__obs-prefix">obs/</span>${escapeHtml(s.projectName.replace(/^obs\//, ''))}`
            : escapeHtml(s.projectName)
          }
        </h2>
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

        ${metricsLine}
        ${toolChain}

        <footer class="entry__foot">
          ${pills ? `<span class="entry__pills">${pills}</span>` : '<span></span>'}
          <code class="entry__hash">${sidShort}</code>
        </footer>
      </div>
    </article>
  `;
}

function sessionSignature(s) {
  const recentTools = (s.toolHistory || []).slice(-CHAIN_LIMIT).map((t) => t.name).join('>');
  return [
    s.status,
    s.title || '',
    s.projectName || '',
    s.isObserver ? '1' : '0',
    s.gitBranch || '',
    s.model || '',
    s.currentTool || '',
    s.currentToolDetail || '',
    s.toolCount || 0,
    s.tokens?.total || 0,
    s.userMessageCount || 0,
    s.assistantMessageCount || 0,
    s.durationSeconds || 0,
    Object.keys(s.toolUsage || {}).sort().join(','),
    Math.round((s.costUsd || 0) * 100),
    Math.round((s.tokensLast5Min || 0) / 1000),
    recentTools,
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
  const workItems = liveWorkItems();
  const totalVisible = visible.length + workItems.length;

  if (totalVisible === 0) {
    for (const el of entryEls.values()) el.remove();
    entryEls.clear();
    emptyEl.hidden = currentFilter === 'stats';
  } else {
    emptyEl.hidden = true;
    const visibleIds = new Set(visible.map((s) => s.sessionId));

    for (const [sid, el] of entryEls) {
      if (sid.startsWith('agent:') || sid.startsWith('skill:')) continue;
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

    const workKeys = new Set();
    for (const item of workItems) {
      const key = item.kind === 'agent'
        ? `agent:${item.ev.sessionId}:${item.ev.name}:${item.ev.timestamp}`
        : `skill:${item.ev.sessionId}:${item.ev.name}:${item.ev.timestamp}`;
      workKeys.add(key);

      let el = entryEls.get(key);
      if (!el) {
        el = htmlToElement(renderLiveCard(item));
        entryEls.set(key, el);
        grid.appendChild(el);
      } else {
        const timeEl = el.querySelector('.live-card__time');
        if (timeEl) {
          const ageSec = Math.max(0, Math.floor((Date.now() - item.ts) / 1000));
          timeEl.textContent = `${fmtAge(ageSec)} ago`;
        }
      }
    }

    for (const [key, el] of entryEls) {
      if (key.startsWith('agent:') || key.startsWith('skill:')) {
        if (!workKeys.has(key)) {
          el.remove();
          entryEls.delete(key);
        }
      }
    }
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

  if (totalTodayCostEl) totalTodayCostEl.textContent = fmtCost(stats.todayCost || 0);
  if (totalWeekCostEl) totalWeekCostEl.textContent = fmtCost(stats.weekCost || 0);
  if (totalMonthCostEl) totalMonthCostEl.textContent = fmtCost(stats.monthCost || 0);

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

  renderChart24();
  renderTop(topTodayEl, stats.topToday);
  renderTop(topWeekEl, stats.topWeek);
  renderTop(topMonthEl, stats.topMonth);
}

function hourToAmPm(h) {
  const period = h < 12 ? 'a' : 'p';
  const display = h % 12 === 0 ? 12 : h % 12;
  return { display, period };
}

const MONTH_SHORT = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function chartItemsForRange() {
  if (!stats) return { items: [], title: '', cols: 24 };
  if (chartRange === 'days') {
    const days = stats.last7Days || [];
    return {
      title: '▸ last 7 days',
      cols: days.length || 7,
      items: days.map((d) => ({
        tokens: d.tokens,
        isCurrent: d.isCurrent,
        label: weekdayShort(d.date),
        tooltip: `${d.date} · ${fmtTokensCompact(d.tokens)} tokens`,
      })),
    };
  }
  if (chartRange === 'weeks') {
    const weeks = stats.last4Weeks || [];
    return {
      title: '▸ last 4 weeks',
      cols: weeks.length || 4,
      items: weeks.map((w) => ({
        tokens: w.tokens,
        isCurrent: w.isCurrent,
        label: `wk ${fmtDateShort(w.weekStart)}`,
        tooltip: `week of ${w.weekStart} · ${fmtTokensCompact(w.tokens)} tokens`,
      })),
    };
  }
  if (chartRange === 'months') {
    const months = stats.last6Months || [];
    return {
      title: '▸ last 6 months',
      cols: months.length || 6,
      items: months.map((m) => ({
        tokens: m.tokens,
        isCurrent: m.isCurrent,
        label: MONTH_SHORT[m.month],
        tooltip: `${MONTH_SHORT[m.month]} ${m.year} · ${fmtTokensCompact(m.tokens)} tokens`,
      })),
    };
  }
  // hours (default)
  const hours = stats.last24Hours || [];
  return {
    title: '▸ last 24h',
    cols: hours.length || 24,
    items: hours.map((h) => {
      const { display, period } = hourToAmPm(h.hour);
      const titleHour = String(h.hour).padStart(2, '0');
      return {
        tokens: h.tokens,
        isCurrent: h.isCurrent,
        label: `${display}<span class="chart24__period">${period}</span>`,
        tooltip: `${titleHour}:00 (${display}${period === 'a' ? 'AM' : 'PM'}) · ${fmtTokensCompact(h.tokens)} tokens`,
      };
    }),
  };
}

function renderChart24() {
  if (!stats || !chart24El) return;
  const { items, title, cols } = chartItemsForRange();
  if (chartTitleEl) chartTitleEl.textContent = title;
  chart24El.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;

  if (items.length === 0) {
    chart24El.innerHTML = '<div class="top__empty">no data yet</div>';
    return;
  }
  const max = Math.max(...items.map((i) => i.tokens), 1);
  chart24El.innerHTML = items
    .map((it) => {
      const heightPct = it.tokens === 0 ? 0 : Math.max(2, (it.tokens / max) * 100);
      const barClass = [
        'chart24__bar',
        it.tokens === 0 ? 'chart24__bar--zero' : '',
        it.isCurrent ? 'chart24__bar--now' : '',
      ]
        .filter(Boolean)
        .join(' ');
      const showVal = it.isCurrent || it.tokens >= max * 0.5;
      const valStr = it.tokens > 0 ? fmtTokensCompact(it.tokens) : '';
      return `
        <div class="chart24__hour" title="${it.tooltip}">
          <span class="${barClass}" style="height:${heightPct.toFixed(1)}%"></span>
          ${showVal && valStr ? `<span class="chart24__val">${valStr}</span>` : ''}
          <span class="chart24__label ${it.isCurrent ? 'chart24__label--now' : ''}">${it.label}</span>
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
      const cost = p.cost && p.cost > 0 ? `<span class="top__cost">${fmtCost(p.cost)}</span>` : '';
      return `
        <li class="top__item">
          <span class="top__rank">${rank}</span>
          <span class="top__name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
          <span class="top__tokens">${fmtTokensCompact(p.tokens)}</span>
          ${cost}
          <span class="top__bar"><span style="width:${widthPct.toFixed(1)}%"></span></span>
        </li>
      `;
    })
    .join('');
}

function fmtAgo(iso) {
  if (!iso) return '—';
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  return `${fmtAge(sec)} ago`;
}

function fmtAvgDuration(totalMs, n) {
  if (!n) return '—';
  const avgSec = Math.floor(totalMs / 1000 / n);
  return fmtDuration(avgSec);
}

function libraryMatches(item, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    (item.slug || '').toLowerCase().includes(q) ||
    (item.name || '').toLowerCase().includes(q) ||
    (item.description || '').toLowerCase().includes(q) ||
    (item.domain || '').toLowerCase().includes(q)
  );
}

function fmtUsageBadge(usage) {
  const n = usage?.thisMonth || 0;
  const cls = n === 0 ? 'zero' : '';
  return `<span class="library-item__usage ${cls}"><strong>${n}</strong>× this month</span>`;
}

function renderChips(containerId, groups, items, currentKey, getGroupOf, onSelect) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const counts = new Map();
  for (const it of items) {
    const g = getGroupOf(it);
    counts.set(g, (counts.get(g) || 0) + 1);
  }
  const chips = [
    { key: 'all', label: 'all', count: items.length },
    ...groups.map((g) => ({ key: g, label: g, count: counts.get(g) || 0 })),
  ];
  el.innerHTML = chips
    .map(
      (c) => `
        <button class="lib-chip" data-active="${c.key === currentKey}" data-group="${escapeHtml(c.key)}">
          ${escapeHtml(c.label)}<span class="lib-chip__count">${c.count}</span>
        </button>
      `,
    )
    .join('');
  el.querySelectorAll('.lib-chip').forEach((btn) => {
    btn.addEventListener('click', () => onSelect(btn.dataset.group));
  });
}

function renderAgents(force) {
  const listEl = document.getElementById('agents-list');
  const countEl = document.getElementById('agents-count');
  if (!listEl) return;

  const all = registry?.agents || [];
  const filtered = all.filter(
    (a) =>
      libraryMatches(a, agentsSearch) && (agentsDomain === 'all' || a.domain === agentsDomain),
  );

  const key = [
    registryHash(all),
    agentsSearch,
    agentsDomain,
  ].join('||');
  if (!force && key === _lastAgentsRenderKey) return;
  _lastAgentsRenderKey = key;

  renderChips(
    'agents-chips',
    registry.agentDomains || [],
    all,
    agentsDomain,
    (a) => a.domain,
    (val) => {
      agentsDomain = val;
      renderAgents(true);
    },
  );

  if (countEl) {
    countEl.textContent = filtered.length === all.length
      ? `${all.length} total`
      : `${filtered.length} / ${all.length} match`;
  }

  if (filtered.length === 0) {
    listEl.innerHTML = '<div class="activity__empty">// no subagents match this filter</div>';
    return;
  }

  listEl.innerHTML = filtered.map(renderAgentLibraryItem).join('');
}

function renderAgentLibraryItem(a) {
  const desc = a.description ? escapeHtml(a.description) : '<em>no description</em>';
  const tools = a.tools
    ? `<span class="label">tools:</span> <span class="val">${escapeHtml(a.tools)}</span>`
    : '';
  const usage = fmtUsageBadge(a.usage);
  return `
    <details class="library-item library-item--agent" data-kind="agent" data-domain="${escapeHtml(a.domain)}" data-slug="${escapeHtml(a.slug)}">
      <summary class="library-item__head">
        <span class="library-item__chevron">▸</span>
        <span class="library-item__name">
          <span class="prefix">↪ </span>${escapeHtml(a.slug)}
        </span>
        ${usage}
        <span class="library-item__domain">${escapeHtml(a.domain)}</span>
        <button class="library-item__copy" data-copy="Agent(subagent_type='${escapeHtml(a.slug)}')" type="button" title="Copy spawn snippet">copy</button>
      </summary>
      <div class="library-item__body">
        <p class="library-item__brief">${desc}</p>
        ${tools ? `<div class="library-item__meta">${tools}</div>` : ''}
        <div class="library-item__detail library-item__detail--loading">// click to expand → loading full profile…</div>
      </div>
    </details>
  `;
}

function renderSkills(force) {
  const listEl = document.getElementById('skills-list');
  const countEl = document.getElementById('skills-count');
  if (!listEl) return;

  const all = registry?.skills || [];
  const filtered = all.filter(
    (s) =>
      libraryMatches(s, skillsSearch) && (skillsGroup === 'all' || s.group === skillsGroup),
  );

  const key = [
    registryHash(all),
    skillsSearch,
    skillsGroup,
  ].join('||');
  if (!force && key === _lastSkillsRenderKey) return;
  _lastSkillsRenderKey = key;

  renderChips(
    'skills-chips',
    registry.skillGroups || [],
    all,
    skillsGroup,
    (s) => s.group,
    (val) => {
      skillsGroup = val;
      renderSkills(true);
    },
  );

  if (countEl) {
    countEl.textContent = filtered.length === all.length
      ? `${all.length} total`
      : `${filtered.length} / ${all.length} match`;
  }

  if (filtered.length === 0) {
    listEl.innerHTML = '<div class="activity__empty">// no skills match this filter</div>';
    return;
  }

  listEl.innerHTML = filtered.map(renderSkillLibraryItem).join('');
}

function renderSkillLibraryItem(s) {
  const desc = s.description ? escapeHtml(s.description) : '<em>no description</em>';
  const args = s.argumentHint
    ? `<span class="label">args:</span> <span class="val">${escapeHtml(s.argumentHint)}</span>`
    : '';
  const usage = fmtUsageBadge(s.usage);
  return `
    <details class="library-item library-item--skill" data-kind="skill" data-slug="${escapeHtml(s.slug)}">
      <summary class="library-item__head">
        <span class="library-item__chevron">▸</span>
        <span class="library-item__name">
          <span class="prefix">/</span>${escapeHtml(s.slug)}
        </span>
        ${usage}
        <span class="library-item__domain">${escapeHtml(s.group || 'skill')}</span>
        <button class="library-item__copy" data-copy="/${escapeHtml(s.slug)}" type="button" title="Copy slash command">copy</button>
      </summary>
      <div class="library-item__body">
        <p class="library-item__brief">${desc}</p>
        ${args ? `<div class="library-item__meta">${args}</div>` : ''}
        <div class="library-item__detail library-item__detail--loading">// click to expand → loading full profile…</div>
      </div>
    </details>
  `;
}

async function fetchDetailFor(item) {
  const kind = item.dataset.kind;
  const slug = item.dataset.slug;
  const domain = item.dataset.domain;
  const cacheKey = kind === 'agent' ? `agent:${domain}:${slug}` : `skill:${slug}`;
  if (detailCache.has(cacheKey)) return detailCache.get(cacheKey);

  const url = kind === 'agent' ? `/api/agent/${domain}/${slug}` : `/api/skill/${slug}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    detailCache.set(cacheKey, data);
    return data;
  } catch {
    return null;
  }
}

function attachLibraryHandlers() {
  document.body.addEventListener('toggle', async (e) => {
    const item = e.target.closest('details.library-item');
    if (!item || !item.open) return;
    const detailEl = item.querySelector('.library-item__detail');
    if (!detailEl || !detailEl.classList.contains('library-item__detail--loading')) return;

    const data = await fetchDetailFor(item);
    if (!data) {
      detailEl.classList.remove('library-item__detail--loading');
      detailEl.innerHTML = '<em>// could not load profile</em>';
      return;
    }
    detailEl.classList.remove('library-item__detail--loading');
    const body = data.body || '';
    detailEl.textContent = body || '// no body content';
  }, true);

  document.body.addEventListener('click', async (e) => {
    const btn = e.target.closest('.library-item__copy');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const text = btn.dataset.copy || '';
    try {
      await navigator.clipboard.writeText(text);
      btn.dataset.copied = 'true';
      const oldText = btn.textContent;
      btn.textContent = '✓ copied';
      setTimeout(() => {
        btn.textContent = oldText;
        delete btn.dataset.copied;
      }, 1400);
    } catch {
      btn.textContent = 'err';
    }
  });

  const agentsSearchEl = document.getElementById('agents-search');
  if (agentsSearchEl) {
    agentsSearchEl.addEventListener('input', (e) => {
      agentsSearch = e.target.value;
      renderAgents(true);
    });
  }
  const skillsSearchEl = document.getElementById('skills-search');
  if (skillsSearchEl) {
    skillsSearchEl.addEventListener('input', (e) => {
      skillsSearch = e.target.value;
      renderSkills(true);
    });
  }
  const projectsSearchEl = document.getElementById('projects-search');
  if (projectsSearchEl) {
    projectsSearchEl.addEventListener('input', (e) => {
      projectsSearch = e.target.value;
      renderProjects(true);
    });
  }
}

attachLibraryHandlers();

function projectMatches(project, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  if (project.name.toLowerCase().includes(q)) return true;
  if (project.relPath.toLowerCase().includes(q)) return true;
  for (const s of project.skills) {
    if (s.slug.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q)) return true;
  }
  for (const a of project.agents) {
    if (a.slug.toLowerCase().includes(q) || (a.description || '').toLowerCase().includes(q)) return true;
  }
  return false;
}

function projectsRegistryHash(projects) {
  if (!projects || projects.length === 0) return '0';
  return projects
    .map((p) => `${p.relPath}:${p.skills.length}+${p.agents.length}`)
    .join('|');
}

function renderProjects(force) {
  const listEl = document.getElementById('projects-list');
  const countEl = document.getElementById('projects-count');
  if (!listEl) return;

  const all = registry?.projects || [];
  const filtered = all.filter((p) => projectMatches(p, projectsSearch));

  const key = [projectsRegistryHash(all), projectsSearch].join('||');
  if (!force && key === _lastProjectsRenderKey) return;
  _lastProjectsRenderKey = key;

  if (countEl) {
    const skillCount = all.reduce((acc, p) => acc + p.skills.length, 0);
    const agentCount = all.reduce((acc, p) => acc + p.agents.length, 0);
    countEl.textContent = `${all.length} projects · ${skillCount} skills · ${agentCount} agents`;
  }

  if (filtered.length === 0) {
    listEl.innerHTML = '<div class="activity__empty">// no projects with .claude/skills or .claude/agents found</div>';
    return;
  }

  listEl.innerHTML = filtered.map(renderProjectCard).join('');
}

function renderProjectCard(p) {
  const skillsList = p.skills.length
    ? `<ul class="proj-card__list">${p.skills.map((s) => renderProjectSkillRow(p, s)).join('')}</ul>`
    : '<p class="proj-card__empty">// none</p>';
  const agentsList = p.agents.length
    ? `<ul class="proj-card__list">${p.agents.map((a) => renderProjectAgentRow(p, a)).join('')}</ul>`
    : '<p class="proj-card__empty">// none</p>';

  return `
    <article class="proj-card">
      <header class="proj-card__head">
        <h3 class="proj-card__name">${escapeHtml(p.name)}</h3>
        <span class="proj-card__path" title="${escapeHtml(p.path)}">${escapeHtml(p.relPath)}</span>
      </header>
      <div class="proj-card__body">
        <div class="proj-card__section">
          <p class="proj-card__section-head">skills <span class="count">(${p.skills.length})</span></p>
          ${skillsList}
        </div>
        <div class="proj-card__section">
          <p class="proj-card__section-head">subagents <span class="count">(${p.agents.length})</span></p>
          ${agentsList}
        </div>
      </div>
    </article>
  `;
}

function renderProjectSkillRow(p, s) {
  const desc = s.description ? escapeHtml(s.description) : '<em>no description</em>';
  const usage = fmtUsageBadge(s.usage);
  const inlineBody = s.body ? escapeHtml(s.body) : '// no body content';
  return `
    <li>
      <details class="library-item library-item--skill" data-kind="project-skill">
        <summary class="library-item__head">
          <span class="library-item__chevron">▸</span>
          <span class="library-item__name">
            <span class="prefix">/</span>${escapeHtml(s.slug)}
          </span>
          ${usage}
          <span class="library-item__domain">project skill</span>
          <button class="library-item__copy" data-copy="/${escapeHtml(s.slug)}" type="button" title="Copy slash command">copy</button>
        </summary>
        <div class="library-item__body">
          <p class="library-item__brief">${desc}</p>
          <div class="library-item__detail">${inlineBody}</div>
        </div>
      </details>
    </li>
  `;
}

function renderProjectAgentRow(p, a) {
  const desc = a.description ? escapeHtml(a.description) : '<em>no description</em>';
  const usage = fmtUsageBadge(a.usage);
  const tools = a.tools
    ? `<div class="library-item__meta"><span class="label">tools:</span> <span class="val">${escapeHtml(a.tools)}</span></div>`
    : '';
  const inlineBody = a.body ? escapeHtml(a.body) : '// no body content';
  return `
    <li>
      <details class="library-item library-item--agent" data-kind="project-agent">
        <summary class="library-item__head">
          <span class="library-item__chevron">▸</span>
          <span class="library-item__name">
            <span class="prefix">↪ </span>${escapeHtml(a.slug)}
          </span>
          ${usage}
          <span class="library-item__domain">project agent</span>
          <button class="library-item__copy" data-copy="Agent(subagent_type='${escapeHtml(a.slug)}')" type="button" title="Copy spawn snippet">copy</button>
        </summary>
        <div class="library-item__body">
          <p class="library-item__brief">${desc}</p>
          ${tools}
          <div class="library-item__detail">${inlineBody}</div>
        </div>
      </details>
    </li>
  `;
}

function renderActivity() {
  if (!activityViewEl) return;
  const list = activity?.timeline || [];
  if (list.length === 0) {
    activityViewEl.innerHTML = '<div class="activity__empty">// no activity in window</div>';
    return;
  }
  activityViewEl.innerHTML = list.map(renderActivityRow).join('');
}

function renderActivityRow(ev) {
  const time = new Date(ev.timestamp).toLocaleTimeString('en-GB', { hour12: false });
  const kind = ev.kind === 'agent' ? 'agent' : 'skill';
  let status = '';
  if (ev.kind === 'agent') {
    if (ev.completed) {
      const dur = ev.durationMs ? ` ${fmtDuration(Math.floor(ev.durationMs / 1000))}` : '';
      status = `<span class="activity__status done">✓ done${dur}</span>`;
    } else {
      status = `<span class="activity__status running">● running</span>`;
    }
  } else {
    status = `<span class="activity__status">invoked</span>`;
  }
  return `
    <div class="activity__row" data-kind="${kind}">
      <span class="activity__time">${time}</span>
      <span class="activity__kind">${kind}</span>
      <span class="activity__name" title="${escapeHtml(ev.name)}">${escapeHtml(ev.name)}</span>
      ${status}
      <span class="activity__parent" title="${escapeHtml(ev.projectName)}">${escapeHtml(ev.projectName)}</span>
    </div>
  `;
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
      if (msg.activity) activity = msg.activity;
      if (msg.registry) registry = msg.registry;
      render();
      renderStats();
      renderAgents();
      renderSkills();
      renderProjects();
      renderActivity();
    } else if (msg.type === 'session-update') {
      sessions.set(msg.session.sessionId, msg.session);
      render();
      flashEntry(msg.session.sessionId);
    }
  });
}

connect();
