/* ============================================================
   MVR Maintenance KPI Dashboard — app.js
   Vanilla JS + Supabase JS client + Chart.js

   >>> SET YOUR SUPABASE CREDENTIALS HERE <<<
   Replace the two values below with your project's URL and anon key.
   (Supabase dashboard → Project Settings → API)
   ============================================================ */

const SUPABASE_URL      = 'https://crigkewtzvslkpmsufxk.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNyaWdrZXd0enZzbGtwbXN1ZnhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg0MDc5OTQsImV4cCI6MjA5Mzk4Mzk5NH0.G13M84Qz7mjLXuCtdCHe07BpP7feeBwVD4c2K4czot4';

/* ---- Tunable constants ---- */
const REFRESH_MS        = 15000;            // auto refresh every 15s
const DEFAULT_PLANNED_MIN = 26 * 24 * 60;   // fallback planned time = 26d x 24h x 60m

/* MTTR thresholds (minutes) */
const MTTR_GREEN = 37, MTTR_YELLOW = 60;
/* Loss-time row tint thresholds (minutes) */
const LOSS_RED = 80, LOSS_YELLOW = 60;
/* Downtime card thresholds (minutes) — adjust to your plant scale */
const DOWNTIME_YELLOW = 300, DOWNTIME_RED = 600;

/* ============================================================
   STATE
   ============================================================ */
let sbClient = null;
let currentPeriod = 'today';
let refreshTimer = null;
let isOnline = false;
const charts = {};               // chart instances by id
let usingFallback = false;

/* ============================================================
   INIT
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  startClock();
  bindUI();
  initSupabase();
  loadDashboard();                       // first load
  refreshTimer = setInterval(loadDashboard, REFRESH_MS);
});

/* ---- Supabase client (guarded) ---- */
function initSupabase() {
  const configured =
    SUPABASE_URL && SUPABASE_ANON_KEY &&
    !SUPABASE_URL.includes('YOUR_SUPABASE') &&
    !SUPABASE_ANON_KEY.includes('YOUR_SUPABASE');

  if (!configured) {
    console.warn('[MVR] Supabase not configured — running on sample data.');
    return;                              // fallback mode
  }
  try {
    sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    subscribeRealtime();
  } catch (err) {
    console.error('[MVR] Failed to create Supabase client:', err);
    sbClient = null;
  }
}

/* ---- Realtime subscriptions ---- */
function subscribeRealtime() {
  if (!sbClient) return;
  try {
    sbClient
      .channel('mvr-dashboard')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'repair_logs' }, () => {
        showToast('New repair log received — refreshing…');
        loadDashboard();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pm_history' }, () => {
        showToast('PM record updated — refreshing…');
        loadDashboard();
      })
      .subscribe();
  } catch (err) {
    console.error('[MVR] Realtime subscribe failed:', err);
  }
}

/* ============================================================
   UI BINDINGS
   ============================================================ */
function bindUI() {
  // Period switch
  document.getElementById('periodSwitch').addEventListener('click', (e) => {
    const btn = e.target.closest('.period-btn');
    if (!btn) return;
    document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    currentPeriod = btn.dataset.period;
    loadDashboard();
  });

  // Fullscreen
  document.getElementById('fullscreenBtn').addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });
}

/* ============================================================
   CLOCK
   ============================================================ */
function startClock() {
  const dateEl = document.getElementById('clockDate');
  const timeEl = document.getElementById('clockTime');
  const tick = () => {
    const now = new Date();
    dateEl.textContent = now.toLocaleDateString('en-GB', {
      weekday: 'short', day: '2-digit', month: 'short', year: 'numeric'
    });
    timeEl.textContent = now.toLocaleTimeString('en-GB', { hour12: false });
  };
  tick();
  setInterval(tick, 1000);
}

/* ============================================================
   PERIOD → date range
   ============================================================ */
function getPeriodRange() {
  const now = new Date();
  let start;
  if (currentPeriod === 'today') {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (currentPeriod === 'month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
  } else {
    start = new Date(now.getFullYear(), 0, 1);
  }
  return { startISO: start.toISOString(), start, end: now };
}

/* Planned minutes for the active period (used in Availability / MTBF) */
function plannedMinutesForPeriod(machines) {
  // Prefer summed machines.planned_hours_month when available
  const summedMonthly = (machines || [])
    .reduce((s, m) => s + (Number(m.planned_hours_month) || 0), 0) * 60;

  const base = summedMonthly > 0 ? summedMonthly : DEFAULT_PLANNED_MIN;

  if (currentPeriod === 'today')  return base / 26;     // one working day share
  if (currentPeriod === 'month')  return base;
  return base * 12;                                      // year
}

/* ============================================================
   MAIN LOAD
   ============================================================ */
async function loadDashboard() {
  setLoading(true);
  try {
    const data = sbClient ? await fetchFromSupabase() : getFallbackData();
    usingFallback = !sbClient;
    setConnection(sbClient ? true : false, usingFallback);
    render(data);
    stampUpdate();
  } catch (err) {
    console.error('[MVR] Load failed, showing last sample data:', err);
    setConnection(false, false);
    // Keep the page alive: fall back to sample data so the screen never breaks
    try { render(getFallbackData()); } catch (e) { /* noop */ }
  } finally {
    setLoading(false);
  }
}

/* ---- Supabase fetch (all tables in parallel) ---- */
async function fetchFromSupabase() {
  const { startISO } = getPeriodRange();
  const startDate = startISO.slice(0, 10);   // schema uses DATE columns, compare as YYYY-MM-DD

  const [logsRes, machinesRes, plansRes, histRes] = await Promise.all([
    sbClient.from('repair_logs').select('*').gte('repair_date', startDate).order('repair_date', { ascending: false }),
    sbClient.from('machines').select('*').eq('is_active', true),
    sbClient.from('pm_plans').select('*'),
    sbClient.from('pm_history').select('*').gte('actual_date', startDate)
  ]);

  // If a query errored, surface it so we drop to the catch / offline path
  const firstErr = [logsRes, machinesRes, plansRes, histRes].find(r => r.error);
  if (firstErr) throw firstErr.error;

  return {
    logs:     logsRes.data     || [],
    machines: machinesRes.data || [],
    plans:    plansRes.data    || [],
    history:  histRes.data     || []
  };
}

/* ============================================================
   RENDER PIPELINE
   ============================================================ */
function render(data) {
  const kpis = computeKpis(data);
  renderKpiCards(kpis, data);
  renderCharts(data);
  renderMachines(data.machines, data.logs);
  renderPm(data);
  renderLogs(data.logs);
}

/* ============================================================
   KPI CALCULATIONS
   ============================================================ */
function lossOf(row)  { return Number(row.loss_time_min) || 0; }

function computeKpis(data) {
  const logs = data.logs || [];

  const totalDowntime = logs.reduce((s, r) => s + lossOf(r), 0);
  const frequency     = logs.length;
  const mttr          = frequency ? totalDowntime / frequency : 0;

  const plannedMin = plannedMinutesForPeriod(data.machines);
  const availability = plannedMin > 0
    ? ((plannedMin - totalDowntime) / plannedMin) * 100
    : 0;
  const mtbf = frequency ? (plannedMin - totalDowntime) / frequency : 0;

  // PM achievement — completed plans / total plans (status enum from pm_plans)
  const plans = data.plans || [];
  const totalPlan  = plans.length;
  const completed  = plans.filter(p => p.status === 'Completed').length;
  const pmAchieve  = totalPlan ? (completed / totalPlan) * 100 : 0;

  // Open issues (status not done/closed)
  const openIssues = logs.filter(r => !isStatusDone(r.status)).length;

  // Top loss machine
  const byMachine = aggregateDowntimeByMachine(logs);
  const topLoss = byMachine[0]
    ? `${byMachine[0].name} · ${fmtNum(byMachine[0].total)} min`
    : '—';

  return {
    availability: clampPct(availability),
    totalDowntime,
    frequency,
    mtbf: Math.max(0, mtbf),
    mttr,
    pmAchieve: clampPct(pmAchieve),
    openIssues,
    topLoss
  };
}

/* status helpers tolerate Thai/English variations */
function isStatusDone(status) {
  const s = String(status || '').toLowerCase();
  return ['closed', 'done', 'complete', 'completed', 'finish', 'finished', 'เสร็จ', 'ปิดงาน']
    .some(k => s.includes(k));
}
function isPmCompleted(h) {
  // pm_history.status enum: Completed / Need Follow-up / Temporary Completed / Cancelled
  return h.status === 'Completed';
}

function aggregateDowntimeByMachine(logs) {
  const map = new Map();
  logs.forEach(r => {
    const name = r.machine_name || r.machine_no || 'Unknown';
    map.set(name, (map.get(name) || 0) + lossOf(r));
  });
  return [...map.entries()]
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total);
}

/* ============================================================
   KPI CARD RENDER + COLOR RULES
   ============================================================ */
function renderKpiCards(k, data) {
  // Availability:  >=80 green, 70-79 yellow, <70 red
  setKpi('kpiAvailability', fmtNum(k.availability, 1),
    availabilityClass(k.availability),
    `${data.machines && data.machines.length ? data.machines.length + ' machines' : 'Default planned time'}`);

  // Downtime: normal green / high yellow / very high red
  setKpi('kpiDowntime', fmtNum(k.totalDowntime),
    downtimeClass(k.totalDowntime), 'Sum of loss time');

  setKpi('kpiFrequency', fmtNum(k.frequency), '', 'Breakdown count');

  setKpi('kpiMtbf', fmtNum(k.mtbf), '', 'Mean time between failures');

  // MTTR: <=37 green, 38-60 yellow, >60 red
  setKpi('kpiMttr', fmtNum(k.mttr, 1), mttrClass(k.mttr), 'Mean time to repair');

  // PM achievement uses same band as availability
  setKpi('kpiPm', fmtNum(k.pmAchieve, 1), availabilityClass(k.pmAchieve), 'Completed of plan');

  // Open issues: 0 green, some yellow, many red
  setKpi('kpiOpen', fmtNum(k.openIssues),
    k.openIssues === 0 ? 'is-green' : (k.openIssues <= 5 ? 'is-yellow' : 'is-red'),
    'Unresolved repairs');

  setKpiText('kpiTopLoss', k.topLoss, 'is-red', 'Highest downtime');
}

function availabilityClass(v) { return v >= 80 ? 'is-green' : (v >= 70 ? 'is-yellow' : 'is-red'); }
function mttrClass(v)         { return v <= MTTR_GREEN ? 'is-green' : (v <= MTTR_YELLOW ? 'is-yellow' : 'is-red'); }
function downtimeClass(v)     { return v < DOWNTIME_YELLOW ? 'is-green' : (v < DOWNTIME_RED ? 'is-yellow' : 'is-red'); }

function setKpi(cardId, value, statusClass, foot) {
  const card = document.getElementById(cardId);
  if (!card) return;
  card.classList.remove('is-green', 'is-yellow', 'is-red', 'is-blue');
  if (statusClass) card.classList.add(statusClass);
  card.querySelector('[data-val]').textContent = value;
  if (foot) card.querySelector('[data-foot]').textContent = foot;
}
function setKpiText(cardId, value, statusClass, foot) {
  setKpi(cardId, value, statusClass, foot);
}

/* ============================================================
   CHARTS
   ============================================================ */
const CHART_FONT = "'Sarabun', sans-serif";
const GRID_COLOR = 'rgba(255,255,255,0.06)';
const TICK_COLOR = '#7488a6';

Chart.defaults.font.family = CHART_FONT;
Chart.defaults.color = TICK_COLOR;

function renderCharts(data) {
  renderDowntimeTrend(data.logs);
  renderTopLoss(data.logs);
  renderPareto(data.logs);
  renderBreakdown(data.logs);
}

function toggleEmpty(canvasId, isEmpty) {
  const holder = document.getElementById(canvasId).closest('.chart-holder');
  holder.querySelector('[data-empty]').hidden = !isEmpty;
  document.getElementById(canvasId).style.display = isEmpty ? 'none' : 'block';
}

/* Downtime trend — line by day */
function renderDowntimeTrend(logs) {
  const map = new Map();
  logs.forEach(r => {
    const d = (r.repair_date || '').slice(0, 10);
    if (!d) return;
    map.set(d, (map.get(d) || 0) + lossOf(r));
  });
  const labels = [...map.keys()].sort();
  const values = labels.map(l => map.get(l));
  toggleEmpty('chartDowntimeTrend', labels.length === 0);

  drawChart('chartDowntimeTrend', {
    type: 'line',
    data: {
      labels: labels.map(fmtShortDate),
      datasets: [{
        data: values,
        borderColor: '#4f93d6',
        backgroundColor: 'rgba(79,147,214,0.15)',
        fill: true,
        tension: 0.32,
        pointRadius: 3,
        pointBackgroundColor: '#4f93d6',
        borderWidth: 2
      }]
    },
    options: baseLineOptions()
  });
}

/* Top 5 loss machine — horizontal bar */
function renderTopLoss(logs) {
  const top = aggregateDowntimeByMachine(logs).slice(0, 5);
  toggleEmpty('chartTopLoss', top.length === 0);

  drawChart('chartTopLoss', {
    type: 'bar',
    data: {
      labels: top.map(t => t.name),
      datasets: [{
        data: top.map(t => t.total),
        backgroundColor: '#4f93d6',
        borderRadius: 5,
        barThickness: 22
      }]
    },
    options: {
      indexAxis: 'y',
      ...baseBarOptions()
    }
  });
}

/* Pareto cause — bars + cumulative % line */
function renderPareto(logs) {
  const map = new Map();
  logs.forEach(r => {
    const c = r.cause_name || 'Unspecified';
    map.set(c, (map.get(c) || 0) + 1);
  });
  let entries = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  toggleEmpty('chartPareto', entries.length === 0);
  if (entries.length === 0) return;

  const labels = entries.map(e => e[0]);
  const counts = entries.map(e => e[1]);
  const total = counts.reduce((s, n) => s + n, 0) || 1;
  let run = 0;
  const cumulative = counts.map(n => { run += n; return Math.round((run / total) * 100); });

  drawChart('chartPareto', {
    data: {
      labels,
      datasets: [
        { type: 'bar', data: counts, backgroundColor: '#3f6fa5', borderRadius: 5, order: 2,
          yAxisID: 'y' },
        { type: 'line', data: cumulative, borderColor: '#e6b54a', backgroundColor: '#e6b54a',
          borderWidth: 2, pointRadius: 3, tension: 0.25, order: 1, yAxisID: 'y1' }
      ]
    },
    options: {
      ...baseBarOptions(),
      scales: {
        x: { grid: { display: false }, ticks: { color: TICK_COLOR, font: { size: 10 } } },
        y: { beginAtZero: true, grid: { color: GRID_COLOR }, ticks: { color: TICK_COLOR, precision: 0 } },
        y1: { beginAtZero: true, max: 100, position: 'right',
              grid: { drawOnChartArea: false },
              ticks: { color: '#e6b54a', callback: v => v + '%' } }
      }
    }
  });
}

/* Breakdown type — doughnut */
function renderBreakdown(logs) {
  const map = new Map();
  logs.forEach(r => {
    const t = r.breakdown_type || 'Other';
    map.set(t, (map.get(t) || 0) + 1);
  });
  const labels = [...map.keys()];
  const values = labels.map(l => map.get(l));
  toggleEmpty('chartBreakdown', labels.length === 0);

  const palette = ['#4f93d6', '#34c178', '#e6b54a', '#e5604f', '#8b7fd6', '#46b6c4', '#9aa7bd'];

  drawChart('chartBreakdown', {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: palette, borderColor: '#182539', borderWidth: 2 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: '62%',
      plugins: {
        legend: { position: 'right', labels: { color: '#aebcd2', font: { size: 11 }, boxWidth: 12, padding: 10 } }
      }
    }
  });
}

/* shared option builders */
function baseLineOptions() {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { display: false }, ticks: { color: TICK_COLOR, font: { size: 10 }, maxRotation: 0, autoSkip: true } },
      y: { beginAtZero: true, grid: { color: GRID_COLOR }, ticks: { color: TICK_COLOR } }
    }
  };
}
function baseBarOptions() {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { beginAtZero: true, grid: { color: GRID_COLOR }, ticks: { color: TICK_COLOR } },
      y: { grid: { display: false }, ticks: { color: TICK_COLOR, font: { size: 11 } } }
    }
  };
}

/* create-or-update a chart instance */
function drawChart(id, config) {
  const ctx = document.getElementById(id);
  if (charts[id]) {
    charts[id].data = config.data;
    charts[id].options = config.options;
    if (config.type) charts[id].config.type = config.type;
    charts[id].update();
  } else {
    charts[id] = new Chart(ctx, config);
  }
}

/* ============================================================
   MACHINE STATUS
   ============================================================ */
function renderMachines(machines, logs) {
  const grid = document.getElementById('machineGrid');
  const empty = document.getElementById('machineEmpty');

  if (!machines || machines.length === 0) {
    grid.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const today = new Date().toISOString().slice(0, 10);

  // Build per-machine view from repair_logs (machines table has no live status column,
  // so current status is derived from the latest log).
  const todayLoss = new Map();    // machine_no -> today's downtime
  const latestLog = new Map();    // machine_no -> most recent log row

  (logs || []).forEach(r => {
    const key = r.machine_no || r.machine_name;
    if ((r.repair_date || '').slice(0, 10) === today) {
      todayLoss.set(key, (todayLoss.get(key) || 0) + lossOf(r));
    }
    // logs arrive newest-first, so first seen = latest
    if (!latestLog.has(key)) latestLog.set(key, r);
  });

  grid.innerHTML = machines.map(m => {
    const key = m.machine_no || m.machine_name;
    const name = m.machine_name || 'Machine';
    const last = latestLog.get(key);
    const sev = deriveMachineStatus(last, today);
    const dt = todayLoss.get(key) || 0;
    const prob = last ? (last.problem_name || '—') : 'No recent issue';
    const severity = last ? (last.severity || sev.label) : '—';

    return `
      <div class="machine ${sev.cls}">
        <div class="machine__top">
          <div>
            <div class="machine__name">${esc(name)}</div>
            <div class="machine__no">${esc(m.machine_no || '')}</div>
          </div>
          <span class="machine__badge">${esc(sev.label)}</span>
        </div>
        <div class="machine__row"><span>Line</span><span>${esc(m.production_line || '—')}</span></div>
        <div class="machine__row"><span>Today DT</span><span>${fmtNum(dt)} min</span></div>
        <div class="machine__row"><span>Last problem</span><span>${esc(prob)}</span></div>
        <div class="machine__row"><span>Severity</span><span>${esc(severity)}</span></div>
      </div>`;
  }).join('');
}

/* Derive a live status from the latest repair log of a machine */
function deriveMachineStatus(lastLog, today) {
  if (!lastLog) return { cls: 's-green', label: 'Running' };

  const isToday = (lastLog.repair_date || '').slice(0, 10) === today;
  const open = !isStatusDone(lastLog.status);
  const sev = String(lastLog.severity || '').toLowerCase();

  // Open job today → currently down / under repair
  if (open && isToday) return { cls: 's-red', label: 'Stop/Repair' };
  // High-severity issue logged today but closed → keep an eye (Warning)
  if (isToday && (sev.includes('high') || sev.includes('critical') || sev.includes('สูง')))
    return { cls: 's-yellow', label: 'Warning' };
  // Any still-open job (not today) → Warning
  if (open) return { cls: 's-yellow', label: 'Warning' };

  return { cls: 's-green', label: 'Running' };
}

/* ============================================================
   PM / TPM PROGRESS
   ============================================================ */
function renderPm(data) {
  const plans = data.plans || [];
  const hist  = data.history || [];

  // Counts straight from pm_plans.status enum
  const total     = plans.length;
  const completed = plans.filter(p => p.status === 'Completed').length;
  const overdue   = plans.filter(p => p.status === 'Overdue' || isPmOverdue(p)).length;
  const pending   = plans.filter(p => p.status === 'Pending' || p.status === 'In Progress').length;

  // From pm_history: result = 'Abnormal Found', follow_up_required boolean
  const abnormal  = hist.filter(h => h.result === 'Abnormal Found').length;
  const followup  = hist.filter(h => truthy(h.follow_up_required) || h.result === 'Need Follow-up').length;

  const pct = total ? Math.round((completed / total) * 100) : 0;

  setPmStat('total', total);
  setPmStat('completed', completed);
  setPmStat('pending', pending);
  setPmStat('overdue', overdue);
  setPmStat('abnormal', abnormal);
  setPmStat('followup', followup);

  // ring
  const fill = document.getElementById('pmRingFill');
  const C = 2 * Math.PI * 52;
  fill.style.strokeDashoffset = C - (C * pct) / 100;
  fill.style.stroke = pct >= 80 ? 'var(--green)' : (pct >= 70 ? 'var(--yellow)' : 'var(--red)');
  document.getElementById('pmRingPct').textContent = pct + '%';
}

function isPmOverdue(p) {
  if (p.status === 'Completed' || p.status === 'Cancelled') return false;
  const due = p.next_due_date || p.planned_date;
  if (!due) return false;
  return new Date(due) < new Date();
}
function setPmStat(key, val) {
  const el = document.querySelector(`[data-pm="${key}"]`);
  if (el) el.textContent = fmtNum(val);
}

/* ============================================================
   REPAIR LOGS TABLE
   ============================================================ */
function renderLogs(logs) {
  const body = document.getElementById('logsBody');
  const empty = document.getElementById('logsEmpty');

  if (!logs || logs.length === 0) {
    body.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const rows = logs.slice(0, 10).map(r => {
    const loss = lossOf(r);
    const rowCls = loss > LOSS_RED ? 'row-red' : (loss >= LOSS_YELLOW ? 'row-yellow' : '');
    return `
      <tr class="${rowCls}">
        <td>${esc(fmtShortDate((r.repair_date || '').slice(0,10)))}</td>
        <td>${esc(r.shift || '—')}</td>
        <td>${esc(r.machine_name || r.machine_no || '—')}</td>
        <td>${esc(r.area_point_name || '—')}</td>
        <td>${esc(r.problem_name || '—')}</td>
        <td>${esc(r.cause_name || '—')}</td>
        <td>${esc(r.action_name || '—')}</td>
        <td class="num">${fmtNum(loss)}</td>
        <td>${esc(r.technician_name || '—')}</td>
        <td>${statusPill(r.status)}</td>
      </tr>`;
  }).join('');
  body.innerHTML = rows;
}

function statusPill(status) {
  const s = String(status || '').toLowerCase();
  if (isStatusDone(status)) return `<span class="pill pill--done">${esc(status || 'Closed')}</span>`;
  if (['progress', 'doing', 'wip', 'in progress', 'กำลัง'].some(k => s.includes(k)))
    return `<span class="pill pill--prog">${esc(status)}</span>`;
  if (['open', 'pending', 'wait', 'follow', 'รอ', 'ค้าง'].some(k => s.includes(k)))
    return `<span class="pill pill--open">${esc(status)}</span>`;
  return `<span class="pill pill--neutral">${esc(status || '—')}</span>`;
}

/* ============================================================
   STATUS / META HELPERS
   ============================================================ */
function setConnection(online, fallback) {
  isOnline = online;
  const wrap = document.getElementById('connStatus');
  const label = document.getElementById('connLabel');
  wrap.classList.remove('is-online', 'is-offline');
  if (online) {
    wrap.classList.add('is-online');
    label.textContent = 'Online';
  } else {
    wrap.classList.add('is-offline');
    label.textContent = fallback ? 'Sample data' : 'Offline';
  }
}

function stampUpdate() {
  document.getElementById('lastUpdate').textContent =
    new Date().toLocaleTimeString('en-GB', { hour12: false });
}

function setLoading(on) {
  document.getElementById('loadBar').hidden = !on;
}

let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

/* ============================================================
   SMALL UTILITIES
   ============================================================ */
function fmtNum(n, dp = 0) {
  const num = Number(n) || 0;
  return num.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
function clampPct(v) { return Math.max(0, Math.min(100, v)); }
function truthy(v) {
  if (v === true) return true;
  const s = String(v).toLowerCase();
  return s === 'true' || s === 'yes' || s === '1' || s === 'y';
}
function fmtShortDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ============================================================
   FALLBACK SAMPLE DATA
   Shown only when Supabase isn't configured / unreachable,
   so the dashboard is demonstrable before wiring the DB.
   ============================================================ */
function getFallbackData() {
  const today = new Date();
  const dayISO = (offset) => {
    const d = new Date(today); d.setDate(d.getDate() - offset);
    return d.toISOString().slice(0, 10);   // schema uses DATE
  };

  const machines = [
    { machine_name: 'Injection M-01', machine_no: 'INJ-01', production_line: 'Line A', is_active: true, planned_hours_month: 624 },
    { machine_name: 'Injection M-02', machine_no: 'INJ-02', production_line: 'Line A', is_active: true, planned_hours_month: 624 },
    { machine_name: 'Press P-11',     machine_no: 'PRS-11', production_line: 'Line B', is_active: true, planned_hours_month: 624 },
    { machine_name: 'Conveyor C-05',  machine_no: 'CNV-05', production_line: 'Line B', is_active: true, planned_hours_month: 624 },
    { machine_name: 'Robot R-03',     machine_no: 'RBT-03', production_line: 'Line C', is_active: true, planned_hours_month: 624 },
    { machine_name: 'Packer K-08',    machine_no: 'PKG-08', production_line: 'Line C', is_active: true, planned_hours_month: 624 }
  ];

  const logs = [
    { id: 1,  repair_date: dayISO(0), shift: 'A', machine_name: 'Press P-11',    machine_no: 'PRS-11', area_point_name: 'Hydraulic', problem_name: 'Oil leak',       cause_name: 'Worn seal',        action_name: 'Replace seal',    loss_time_min: 95, technician_name: 'Somchai', severity: 'High',   status: 'Open',   breakdown_type: 'Mechanical' },
    { id: 2,  repair_date: dayISO(0), shift: 'A', machine_name: 'Injection M-02',machine_no: 'INJ-02', area_point_name: 'Heater',    problem_name: 'Temp unstable',  cause_name: 'Sensor fault',     action_name: 'Recalibrate',     loss_time_min: 68, technician_name: 'Wichai',  severity: 'Medium', status: 'Closed', breakdown_type: 'Electrical' },
    { id: 3,  repair_date: dayISO(1), shift: 'B', machine_name: 'Conveyor C-05', machine_no: 'CNV-05', area_point_name: 'Belt',      problem_name: 'Belt slip',      cause_name: 'Tension low',      action_name: 'Adjust tension',  loss_time_min: 42, technician_name: 'Anan',    severity: 'Low',    status: 'Closed', breakdown_type: 'Mechanical' },
    { id: 4,  repair_date: dayISO(1), shift: 'A', machine_name: 'Robot R-03',    machine_no: 'RBT-03', area_point_name: 'Gripper',   problem_name: 'No grip',        cause_name: 'Air pressure',     action_name: 'Fix air line',    loss_time_min: 30, technician_name: 'Somchai', severity: 'Low',    status: 'Closed', breakdown_type: 'Pneumatic' },
    { id: 5,  repair_date: dayISO(2), shift: 'C', machine_name: 'Press P-11',    machine_no: 'PRS-11', area_point_name: 'Motor',     problem_name: 'Overheat',       cause_name: 'Bearing wear',     action_name: 'Replace bearing', loss_time_min: 120,technician_name: 'Wichai',  severity: 'High',   status: 'Closed', breakdown_type: 'Mechanical' },
    { id: 6,  repair_date: dayISO(2), shift: 'A', machine_name: 'Packer K-08',   machine_no: 'PKG-08', area_point_name: 'Sealer',    problem_name: 'Seal weak',      cause_name: 'Heater aging',     action_name: 'Replace heater',  loss_time_min: 55, technician_name: 'Anan',    severity: 'Medium', status: 'Open',   breakdown_type: 'Electrical' },
    { id: 7,  repair_date: dayISO(3), shift: 'B', machine_name: 'Injection M-01',machine_no: 'INJ-01', area_point_name: 'Nozzle',    problem_name: 'Clog',           cause_name: 'Material residue', action_name: 'Clean nozzle',    loss_time_min: 25, technician_name: 'Somchai', severity: 'Low',    status: 'Closed', breakdown_type: 'Process' },
    { id: 8,  repair_date: dayISO(3), shift: 'A', machine_name: 'Conveyor C-05', machine_no: 'CNV-05', area_point_name: 'Roller',    problem_name: 'Noise',          cause_name: 'Lack lubrication', action_name: 'Lubricate',       loss_time_min: 18, technician_name: 'Wichai',  severity: 'Low',    status: 'Closed', breakdown_type: 'Mechanical' },
    { id: 9,  repair_date: dayISO(4), shift: 'C', machine_name: 'Robot R-03',    machine_no: 'RBT-03', area_point_name: 'Axis 2',    problem_name: 'Position drift', cause_name: 'Encoder',          action_name: 'Replace encoder', loss_time_min: 88, technician_name: 'Anan',    severity: 'High',   status: 'Closed', breakdown_type: 'Electrical' },
    { id: 10, repair_date: dayISO(4), shift: 'A', machine_name: 'Injection M-02',machine_no: 'INJ-02', area_point_name: 'Mold',      problem_name: 'Flash defect',   cause_name: 'Clamp force',      action_name: 'Adjust clamp',    loss_time_min: 47, technician_name: 'Somchai', severity: 'Medium', status: 'Closed', breakdown_type: 'Process' }
  ];

  // pm_plans.status enum: Pending / In Progress / Completed / Overdue / Cancelled
  const planStatuses = ['Completed','Completed','Completed','Completed','Completed','Completed','Completed','Completed','Completed','Completed','Completed','Completed','Completed','In Progress','In Progress','Pending','Pending','Pending','Overdue','Overdue'];
  const plans = planStatuses.map((st, i) => ({
    id: i + 1,
    pm_no: 'PM-' + String(i + 1).padStart(3, '0'),
    machine_no: machines[i % machines.length].machine_no,
    machine_name: machines[i % machines.length].machine_name,
    planned_date: dayISO(i - 5),
    next_due_date: dayISO(i - 5),
    status: st
  }));

  // pm_history.result enum + follow_up_required boolean
  const history = Array.from({ length: 15 }, (_, i) => ({
    id: i + 1,
    pm_no: 'PM-' + String(i + 1).padStart(3, '0'),
    actual_date: dayISO(i),
    status: 'Completed',
    result: i % 6 === 0 ? 'Abnormal Found' : 'Normal',
    follow_up_required: i % 7 === 0
  }));

  return { logs, machines, plans, history };
}