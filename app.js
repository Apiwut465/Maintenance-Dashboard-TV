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
const REFRESH_MS        = 100000;            // auto refresh every 15s
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

/* deck (page rotation) state */
const PAGE_COUNT = 4;
const PAGE_MS = 15000;           // seconds each page stays on screen
let currentPage = 0;
let pageTimer = null;
let progressTimer = null;
let isPaused = false;
let progressStart = 0;

/* ============================================================
   INIT
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  startClock();
  bindUI();
  initDeck();
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

  // Theme toggle
  document.getElementById('themeBtn').addEventListener('click', toggleTheme);

  // Settings (technician photos)
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('settingsClose').addEventListener('click', closeSettings);
  document.getElementById('settingsModal').addEventListener('click', (e) => {
    if (e.target.id === 'settingsModal') closeSettings();   // click backdrop to close
  });

  // Fullscreen
  document.getElementById('fullscreenBtn').addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });

  // Deck dots — jump to a page
  document.getElementById('deckDots').addEventListener('click', (e) => {
    const dot = e.target.closest('.deck-dot');
    if (!dot) return;
    goToPage(Number(dot.dataset.go), true);
  });

  // Play / pause rotation
  document.getElementById('playBtn').addEventListener('click', togglePause);

  // Keyboard: ← → switch page, space = pause/play, F = fullscreen, T = theme
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeSettings(); return; }
    // ignore deck shortcuts while the settings modal is open
    if (!document.getElementById('settingsModal').hidden) return;
    if (e.key === 'ArrowRight') goToPage((currentPage + 1) % PAGE_COUNT, true);
    else if (e.key === 'ArrowLeft') goToPage((currentPage - 1 + PAGE_COUNT) % PAGE_COUNT, true);
    else if (e.key === ' ') { e.preventDefault(); togglePause(); }
    else if (e.key.toLowerCase() === 'f') document.getElementById('fullscreenBtn').click();
    else if (e.key.toLowerCase() === 't') toggleTheme();
  });
}

/* ============================================================
   THEME (light / dark, remembered)
   ============================================================ */
function initTheme() {
  // default dark; honour saved choice if present
  let saved = 'dark';
  try { saved = localStorage.getItem('mvr-theme') || 'dark'; } catch (e) {}
  document.documentElement.setAttribute('data-theme', saved);
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('mvr-theme', next); } catch (e) {}
  // recolour chart axes/grids for the new theme
  refreshChartTheme();
}

/* ============================================================
   SETTINGS — technician photo management
   ============================================================ */
const TECH_BUCKET = 'technician-photos';

function openSettings() {
  const modal = document.getElementById('settingsModal');
  modal.hidden = false;
  // pause rotation while managing settings
  if (!isPaused) { clearInterval(pageTimer); clearInterval(progressTimer); }
  loadTechManager();
}
function closeSettings() {
  const modal = document.getElementById('settingsModal');
  if (modal.hidden) return;
  modal.hidden = true;
  setSettingsNote('', null);
  if (!isPaused) startPageTimer();        // resume rotation
}

function setSettingsNote(msg, kind) {
  const note = document.getElementById('settingsNote');
  if (!msg) { note.hidden = true; return; }
  note.hidden = false;
  note.textContent = msg;
  note.className = 'modal__note' + (kind === 'error' ? ' is-error' : kind === 'ok' ? ' is-ok' : '');
}

/* Load the technician list into the manager grid */
async function loadTechManager() {
  const grid = document.getElementById('techManageGrid');

  if (!sbClient) {
    grid.innerHTML = '';
    setSettingsNote('ยังไม่ได้เชื่อม Supabase — ใส่ URL และ Anon Key ใน app.js ก่อนจึงจะอัปโหลดรูปได้', 'error');
    return;
  }

  grid.innerHTML = '<div class="state-empty" style="position:static">Loading technicians…</div>';
  try {
    const { data, error } = await sbClient
      .from('technicians')
      .select('id, employee_code, full_name, position, photo_url, is_active')
      .order('full_name', { ascending: true });
    if (error) throw error;

    const techs = (data || []).filter(t => t.is_active !== false);
    if (techs.length === 0) {
      grid.innerHTML = '<div class="state-empty" style="position:static">No technicians found in the database.</div>';
      return;
    }

    grid.innerHTML = techs.map(t => {
      const hasPhoto = !!t.photo_url;
      const avatar = hasPhoto
        ? `<img class="tech-manage__avatar" src="${esc(t.photo_url)}" alt="">`
        : `<span class="tech-manage__avatar">${esc(initials(t.full_name))}</span>`;
      return `
        <div class="tech-manage" data-tech-id="${esc(t.id)}">
          ${avatar}
          <div class="tech-manage__info">
            <div class="tech-manage__name">${esc(t.full_name || '—')}</div>
            <div class="tech-manage__code">${esc(t.employee_code || '')}${t.position ? ' · ' + esc(t.position) : ''}</div>
            <button class="tech-manage__btn ${hasPhoto ? 'tech-manage__btn--has' : ''}" data-upload="${esc(t.id)}">
              ${hasPhoto ? 'เปลี่ยนรูป' : 'อัปโหลดรูป'}
            </button>
          </div>
          <input type="file" accept="image/*" data-file="${esc(t.id)}" hidden>
        </div>`;
    }).join('');

    // wire up each upload button → hidden file input → upload handler
    grid.querySelectorAll('[data-upload]').forEach(btn => {
      const id = btn.getAttribute('data-upload');
      const input = grid.querySelector(`[data-file="${id}"]`);
      btn.addEventListener('click', () => input.click());
      input.addEventListener('change', () => handlePhotoUpload(id, input.files[0], btn));
    });

  } catch (err) {
    console.error('[MVR] loadTechManager failed:', err);
    grid.innerHTML = '';
    setSettingsNote('โหลดรายชื่อช่างไม่สำเร็จ: ' + (err.message || err), 'error');
  }
}

/* Upload one photo: Storage → get public URL → save to technicians.photo_url */
async function handlePhotoUpload(techId, file, btn) {
  if (!file) return;
  if (!file.type.startsWith('image/')) { setSettingsNote('ไฟล์ต้องเป็นรูปภาพเท่านั้น', 'error'); return; }
  if (file.size > 5 * 1024 * 1024) { setSettingsNote('รูปใหญ่เกิน 5MB กรุณาเลือกรูปที่เล็กกว่านี้', 'error'); return; }

  const original = btn.textContent;
  btn.classList.add('is-busy');
  btn.textContent = 'กำลังอัปโหลด…';
  setSettingsNote('', null);

  try {
    // unique-ish path so the CDN doesn't serve a stale cached image
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const path = `${techId}-${Date.now()}.${ext}`;

    // 1) upload to Storage bucket
    const up = await sbClient.storage.from(TECH_BUCKET).upload(path, file, {
      cacheControl: '3600', upsert: true, contentType: file.type
    });
    if (up.error) throw up.error;

    // 2) public URL
    const { data: pub } = sbClient.storage.from(TECH_BUCKET).getPublicUrl(path);
    const photoUrl = pub.publicUrl;

    // 3) save URL onto the technician row
    const upd = await sbClient.from('technicians').update({ photo_url: photoUrl }).eq('id', techId);
    if (upd.error) throw upd.error;

    setSettingsNote('บันทึกรูปเรียบร้อย ✓', 'ok');
    await loadTechManager();          // refresh the grid
    loadDashboard();                  // refresh the live table so the new photo shows

  } catch (err) {
    console.error('[MVR] photo upload failed:', err);
    btn.classList.remove('is-busy');
    btn.textContent = original;
    // common cause: bucket missing or policy not set
    const hint = /bucket/i.test(err.message || '')
      ? ' (ตรวจสอบว่าสร้าง bucket "technician-photos" และตั้ง policy แล้ว)' : '';
    setSettingsNote('อัปโหลดไม่สำเร็จ: ' + (err.message || err) + hint, 'error');
  }
}

/* ============================================================
   DECK — rotating pages
   ============================================================ */
function initDeck() {
  goToPage(0, false);
  startPageTimer();
}

function goToPage(index, userInitiated) {
  currentPage = index;
  document.querySelectorAll('.page').forEach((p, i) => p.classList.toggle('is-active', i === index));
  document.querySelectorAll('.deck-dot').forEach((d, i) => d.classList.toggle('is-active', i === index));

  // Chart.js sizes to a hidden 0x0 canvas; when a page reveals, resize its charts
  setTimeout(() => Object.values(charts).forEach(c => { try { c.resize(); } catch (e) {} }), 60);

  // a manual jump restarts the dwell timer
  if (userInitiated && !isPaused) startPageTimer();
}

function startPageTimer() {
  clearInterval(pageTimer);
  clearInterval(progressTimer);
  if (isPaused) return;

  progressStart = Date.now();
  updateProgress();
  progressTimer = setInterval(updateProgress, 200);

  pageTimer = setInterval(() => {
    goToPage((currentPage + 1) % PAGE_COUNT, false);
    progressStart = Date.now();
  }, PAGE_MS);
}

function updateProgress() {
  const bar = document.querySelector('#deckProgress span');
  if (!bar) return;
  const pct = Math.min(100, ((Date.now() - progressStart) / PAGE_MS) * 100);
  bar.style.width = pct + '%';
}

function togglePause() {
  isPaused = !isPaused;
  document.querySelector('.deck-nav').classList.toggle('is-paused', isPaused);
  if (isPaused) {
    clearInterval(pageTimer);
    clearInterval(progressTimer);
  } else {
    startPageTimer();
  }
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

  const [logsRes, machinesRes, plansRes, histRes, techRes] = await Promise.all([
    sbClient.from('repair_logs').select('*').gte('repair_date', startDate).order('repair_date', { ascending: false }),
    sbClient.from('machines').select('*').eq('is_active', true),
    sbClient.from('pm_plans').select('*'),
    sbClient.from('pm_history').select('*').gte('actual_date', startDate),
    sbClient.from('technicians').select('id, employee_code, full_name, position, photo_url, is_active')
  ]);

  // If a query errored, surface it so we drop to the catch / offline path
  const firstErr = [logsRes, machinesRes, plansRes, histRes, techRes].find(r => r.error);
  if (firstErr) throw firstErr.error;

  return {
    logs:     logsRes.data     || [],
    machines: machinesRes.data || [],
    plans:    plansRes.data    || [],
    history:  histRes.data     || [],
    technicians: techRes.data  || []
  };
}

/* ============================================================
   RENDER PIPELINE
   ============================================================ */
function render(data) {
  buildTechIndex(data.technicians);          // name/code → photo lookup
  const kpis = computeKpis(data);
  renderKpiCards(kpis, data);
  renderCharts(data);
  renderMachines(data.machines, data.logs);
  renderPm(data);
  renderLogs(data.logs);
}

/* technician lookup — keyed by both full_name and employee_code */
let techIndex = {};
function buildTechIndex(techs) {
  techIndex = {};
  (techs || []).forEach(t => {
    if (t.full_name)     techIndex['name:' + t.full_name.trim()] = t;
    if (t.employee_code) techIndex['code:' + t.employee_code.trim()] = t;
  });
}
function findTech(name, code) {
  if (code && techIndex['code:' + String(code).trim()]) return techIndex['code:' + String(code).trim()];
  if (name && techIndex['name:' + String(name).trim()]) return techIndex['name:' + String(name).trim()];
  return null;
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

/* read live theme colors from CSS variables */
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function gridColor() { return cssVar('--grid-line') || 'rgba(255,255,255,0.06)'; }
function tickColor() { return cssVar('--text-dim') || '#7488a6'; }
function accentColor() { return cssVar('--accent') || '#4f93d6'; }

Chart.defaults.font.family = CHART_FONT;


/* ------------------------------------------------------------
   Always-visible chart labels
   - Shows KPI values directly on charts, so TV/kiosk users do not need hover tooltips.
   - No external ChartDataLabels plugin required.
   ------------------------------------------------------------ */
function isLightTheme() { return document.documentElement.getAttribute('data-theme') === 'light'; }
function chartLabelTextColor()  { return isLightTheme() ? '#23324a' : '#eef3fb'; }
function chartLabelBgColor()    { return isLightTheme() ? 'rgba(255, 255, 255, 0.92)' : 'rgba(24, 37, 57, 0.90)'; }
function chartLabelBorderColor(){ return isLightTheme() ? 'rgba(24, 35, 58, 0.08)' : 'rgba(255, 255, 255, 0.08)'; }
function chartLabelShadowColor(){ return isLightTheme() ? 'rgba(15, 23, 42, 0.10)' : 'rgba(0, 0, 0, 0.24)'; }

function toLabelLines(value) {
  if (Array.isArray(value)) return value.map(v => String(v));
  return String(value).split('\n');
}

function drawRoundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function drawLabelBox(ctx, label, x, y, opt = {}) {
  const lines = toLabelLines(label).filter(Boolean);
  if (!lines.length) return;

  const fontSize = opt.fontSize || 10.5;
  const fontWeight = opt.fontWeight || 600;
  const lineHeight = Math.round(fontSize * 1.16);
  const padX = opt.paddingX ?? 7;
  const padY = opt.paddingY ?? 3;
  const radius = opt.radius ?? 8;
  const align = opt.align || 'center';
  const baseline = opt.baseline || 'middle';
  const chartArea = opt.chartArea;

  ctx.save();
  ctx.font = `${fontWeight} ${fontSize}px Sarabun, sans-serif`;
  const textW = Math.max(...lines.map(t => ctx.measureText(t).width));
  const boxW = Math.ceil(textW + padX * 2);
  const boxH = Math.ceil((lines.length * lineHeight) + padY * 2);

  let left = align === 'left' ? x : align === 'right' ? x - boxW : x - boxW / 2;
  let top  = baseline === 'top' ? y : baseline === 'bottom' ? y - boxH : y - boxH / 2;

  // Keep labels inside the chart area, preventing cut-off at panel edges.
  if (chartArea) {
    const margin = 2;
    left = Math.max(chartArea.left + margin, Math.min(left, chartArea.right - boxW - margin));
    top  = Math.max(chartArea.top + margin,  Math.min(top,  chartArea.bottom - boxH - margin));
  }

  const plain = opt.plain !== false;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = opt.color || chartLabelTextColor();

  if (!plain) {
    ctx.fillStyle = opt.backgroundColor || chartLabelBgColor();
    ctx.strokeStyle = opt.borderColor || chartLabelBorderColor();
    ctx.lineWidth = 1;
    ctx.shadowColor = opt.shadowColor || chartLabelShadowColor();
    ctx.shadowBlur = opt.shadowBlur ?? 10;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 2;
    drawRoundRect(ctx, left, top, boxW, boxH, radius);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.stroke();
  }

  lines.forEach((line, i) => {
    const ty = top + padY + (i * lineHeight) + lineHeight / 2;
    ctx.fillText(line, left + boxW / 2, ty);
  });
  ctx.restore();
}

function defaultChartLabelFormatter(value) {
  const n = Number(value);
  return Number.isFinite(n) ? fmtNum(n) : String(value ?? '');
}

function drawDoughnutValueLabels(chart, opts) {
  const ctx = chart.ctx;
  const dataset = chart.data.datasets[0] || {};
  const values = (dataset.data || []).map(v => Number(v) || 0);
  const total = values.reduce((s, n) => s + n, 0) || 1;
  const meta = chart.getDatasetMeta(0);

  meta.data.forEach((arc, index) => {
    const value = values[index];
    if (!value) return;

    const p = arc.getProps(['x', 'y', 'startAngle', 'endAngle', 'innerRadius', 'outerRadius'], true);
    const angle = (p.startAngle + p.endAngle) / 2;
    const radius = p.innerRadius + ((p.outerRadius - p.innerRadius) * 0.56);
    const x = p.x + Math.cos(angle) * radius;
    const y = p.y + Math.sin(angle) * radius;
    const label = opts.formatter
      ? opts.formatter(value, { chart, dataset, datasetIndex: 0, dataIndex: index })
      : `${fmtNum((value / total) * 100, 0)}%`;

    drawLabelBox(ctx, label, x, y, {
      chartArea: chart.chartArea,
      fontSize: opts.fontSize || 11,
      fontWeight: opts.fontWeight || 600,
      color: opts.color,
      paddingX: opts.paddingX ?? 6,
      paddingY: opts.paddingY ?? 4,
      radius: opts.radius ?? 7,
      plain: opts.plain !== false
    });
  });
}

function labelPositionForElement(chart, element, dataset, dsType) {
  const indexAxis = chart.options.indexAxis || 'x';
  const pos = element.tooltipPosition ? element.tooltipPosition() : { x: element.x, y: element.y };

  if (dsType === 'bar') {
    if (indexAxis === 'y') {
      return { x: element.x + 8, y: element.y, align: 'left', baseline: 'middle' };
    }
    return { x: element.x, y: element.y - 8, align: 'center', baseline: 'bottom' };
  }

  // line / point labels
  return { x: pos.x, y: pos.y - 10, align: 'center', baseline: 'bottom' };
}

const CHART_VALUE_LABEL_PLUGIN = {
  id: 'alwaysValueLabels',
  afterDatasetsDraw(chart, args, pluginOptions) {
    const opts = pluginOptions || {};
    if (opts.enabled === false) return;

    const chartType = chart.config.type;
    if (chartType === 'doughnut' || chartType === 'pie') {
      drawDoughnutValueLabels(chart, opts);
      return;
    }

    const ctx = chart.ctx;
    chart.data.datasets.forEach((dataset, datasetIndex) => {
      const meta = chart.getDatasetMeta(datasetIndex);
      if (!meta || meta.hidden) return;

      const dsType = dataset.type || chartType;
      const values = dataset.data || [];
      meta.data.forEach((element, dataIndex) => {
        const raw = values[dataIndex];
        const value = Number(raw);
        if (!Number.isFinite(value)) return;
        if (opts.hideZero && value === 0) return;

        const label = opts.formatter
          ? opts.formatter(raw, { chart, dataset, datasetIndex, dataIndex })
          : defaultChartLabelFormatter(raw);
        if (!label) return;

        const p = labelPositionForElement(chart, element, dataset, dsType);
        drawLabelBox(ctx, label, p.x, p.y, {
          chartArea: chart.chartArea,
          align: p.align,
          baseline: p.baseline,
          fontSize: opts.fontSize || 11,
          fontWeight: opts.fontWeight || 600,
          color: opts.color,
          paddingX: opts.paddingX ?? 6,
          paddingY: opts.paddingY ?? 4,
          radius: opts.radius ?? 6,
          plain: opts.plain !== false
        });
      });
    });
  }
};

Chart.register(CHART_VALUE_LABEL_PLUGIN);

/* re-apply theme colors to existing charts (called on theme switch) */
function refreshChartTheme() {
  Object.values(charts).forEach(c => {
    try {
      const s = c.options.scales || {};
      Object.values(s).forEach(axis => {
        if (axis.grid) axis.grid.color = gridColor();
        if (axis.ticks && axis.ticks.color && axis.ticks.color !== accentColor()) axis.ticks.color = tickColor();
      });
      if (c.options.plugins && c.options.plugins.legend && c.options.plugins.legend.labels)
        c.options.plugins.legend.labels.color = cssVar('--text-mid');
      c.update('none');
    } catch (e) {}
  });
}

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
        borderColor: accentColor(),
        backgroundColor: cssVar('--accent-soft') || 'rgba(79,147,214,0.15)',
        fill: true,
        tension: 0.32,
        pointRadius: 4,
        pointHoverRadius: 5,
        pointBackgroundColor: accentColor(),
        borderWidth: 2
      }]
    },
    options: baseLineOptions({
      enabled: true,
      formatter: value => fmtNum(value),
      fontSize: 10.5,
      fontWeight: 600,
      hideZero: true
    })
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
        backgroundColor: accentColor(),
        borderRadius: 5,
        barThickness: 22
      }]
    },
    options: {
      indexAxis: 'y',
      ...baseBarOptions({
        enabled: true,
        formatter: value => fmtNum(value),
        fontSize: 10.5,
        fontWeight: 600,
        hideZero: true
      })
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
    type: 'bar',
    data: {
      labels,
      datasets: [
        { type: 'bar', data: counts, backgroundColor: '#3f6fa5', borderRadius: 5, order: 2,
          yAxisID: 'y' },
        { type: 'line', data: cumulative, borderColor: '#e6b54a', backgroundColor: '#e6b54a',
          borderWidth: 2, pointRadius: 4, pointHoverRadius: 5, tension: 0.25, order: 1, yAxisID: 'y1' }
      ]
    },
    options: {
      ...baseBarOptions({
        enabled: true,
        formatter: (value, ctx) => ctx.dataset.yAxisID === 'y1' ? `${fmtNum(value)}%` : fmtNum(value),
        fontSize: 10,
        fontWeight: 600,
        hideZero: true
      }),
      scales: {
        x: { grid: { display: false }, ticks: { color: tickColor(), font: { size: 10 } } },
        y: { beginAtZero: true, grid: { color: gridColor() }, ticks: { color: tickColor(), precision: 0 } },
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
      datasets: [{ data: values, backgroundColor: palette, borderColor: cssVar('--surface'), borderWidth: 2 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: '62%',
      layout: { padding: 12 },
      plugins: {
        legend: { position: 'right', labels: { color: cssVar('--text-mid'), font: { size: 11 }, boxWidth: 12, padding: 10 } },
        tooltip: { enabled: true },
        alwaysValueLabels: {
          enabled: true,
          formatter: (value, ctx) => {
            const data = ctx.chart.data.datasets[0].data.map(v => Number(v) || 0);
            const total = data.reduce((s, n) => s + n, 0) || 1;
            const pct = (Number(value) / total) * 100;
            return `${fmtNum(pct, 0)}%`;
          },
          color: '#ffffff',
          fontSize: 10,
          fontWeight: 600
        }
      }
    }
  });
}

/* shared option builders */
function baseLineOptions(labelOptions = { enabled: false }) {
  return {
    responsive: true, maintainAspectRatio: false,
    layout: { padding: { top: 28, right: 22, bottom: 4, left: 4 } },
    plugins: {
      legend: { display: false },
      tooltip: { enabled: true },
      alwaysValueLabels: labelOptions
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: tickColor(), font: { size: 10 }, maxRotation: 0, autoSkip: true } },
      y: { beginAtZero: true, grid: { color: gridColor() }, ticks: { color: tickColor() } }
    }
  };
}
function baseBarOptions(labelOptions = { enabled: false }) {
  return {
    responsive: true, maintainAspectRatio: false,
    layout: { padding: { top: 24, right: 38, bottom: 4, left: 4 } },
    plugins: {
      legend: { display: false },
      tooltip: { enabled: true },
      alwaysValueLabels: labelOptions
    },
    scales: {
      x: { beginAtZero: true, grid: { color: gridColor() }, ticks: { color: tickColor() } },
      y: { grid: { display: false }, ticks: { color: tickColor(), font: { size: 11 } } }
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

  // Aggregate per machine across the whole period (this is historical, not real-time).
  // Keyed by machine_no so it stays stable.
  const agg = new Map();
  (logs || []).forEach(r => {
    const key = r.machine_no || r.machine_name;
    if (!key) return;
    let m = agg.get(key);
    if (!m) {
      m = { name: r.machine_name || key, no: r.machine_no || '', line: r.production_line || '—',
            loss: 0, jobs: 0, lastDate: '', lastProblem: '—' };
      agg.set(key, m);
    }
    m.loss += lossOf(r);
    m.jobs += 1;
    const d = (r.repair_date || '').slice(0, 10);
    if (d > m.lastDate) { m.lastDate = d; m.lastProblem = r.problem_name || '—'; }
  });

  // Only show machines that actually had repairs this period, worst loss first
  const rows = [...agg.values()].sort((a, b) => b.loss - a.loss);

  if (rows.length === 0) {
    grid.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  // Color band by share of the top machine's loss (relative severity)
  const maxLoss = rows[0].loss || 1;

  grid.innerHTML = rows.map(m => {
    const ratio = m.loss / maxLoss;
    const cls = ratio >= 0.66 ? 's-red' : (ratio >= 0.33 ? 's-yellow' : 's-green');
    return `
      <div class="machine ${cls}">
        <div class="machine__top">
          <div>
            <div class="machine__no-lead">${esc(m.no || m.name)}</div>
            <div class="machine__name-sub">${esc(m.name)} · ${esc(m.line)}</div>
          </div>
          <span class="machine__badge">${fmtNum(m.loss)}<small> min</small></span>
        </div>
        <div class="machine__row"><span>Breakdowns</span><span>${fmtNum(m.jobs)} ครั้ง</span></div>
        <div class="machine__row"><span>Last repair</span><span>${esc(fmtShortDate(m.lastDate))}</span></div>
        <div class="machine__row"><span>Last problem</span><span>${esc(m.lastProblem)}</span></div>
      </div>`;
  }).join('');
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

  renderPmPlanTable(plans);
  renderPmFindingTable(hist);
}

/* Upcoming & overdue PM plans — overdue first, then soonest due */
function renderPmPlanTable(plans) {
  const body = document.getElementById('pmPlanBody');
  const empty = document.getElementById('pmPlanEmpty');
  if (!body) return;

  // Show only plans that are not yet completed/cancelled
  const active = plans.filter(p => p.status !== 'Completed' && p.status !== 'Cancelled');

  const rank = { 'Overdue': 0, 'In Progress': 1, 'Pending': 2 };
  active.sort((a, b) => {
    const ra = rank[a.status] ?? 3, rb = rank[b.status] ?? 3;
    if (ra !== rb) return ra - rb;
    const da = a.next_due_date || a.planned_date || '';
    const db = b.next_due_date || b.planned_date || '';
    return da.localeCompare(db);
  });

  if (active.length === 0) {
    body.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  body.innerHTML = active.slice(0, 12).map(p => {
    const due = p.next_due_date || p.planned_date || '';
    const isOver = p.status === 'Overdue' || isPmOverdue(p);
    const dueCls = isOver ? 'pm-due-over' : (isDueSoon(due) ? 'pm-due-soon' : '');
    return `
      <tr>
        <td class="pm-cell-strong">${esc(p.machine_no || p.machine_name || '—')}</td>
        <td>${esc(p.pm_title || '—')}</td>
        <td>${esc(p.pm_type || '—')}</td>
        <td class="${dueCls}">${esc(fmtShortDate((due || '').slice(0,10)))}</td>
        <td>${pmStatusPill(p.status)}</td>
      </tr>`;
  }).join('');
}

/* PM findings — abnormalities / follow-ups first */
function renderPmFindingTable(hist) {
  const body = document.getElementById('pmFindingBody');
  const empty = document.getElementById('pmFindingEmpty');
  if (!body) return;

  // Surface anything that isn't a clean "Normal/Completed" pass
  const flagged = hist.filter(h =>
    h.result === 'Abnormal Found' ||
    h.result === 'Need Follow-up' ||
    h.result === 'Temporary Fixed' ||
    h.result === 'Need Spare Part' ||
    truthy(h.follow_up_required)
  );

  flagged.sort((a, b) => (b.actual_date || '').localeCompare(a.actual_date || ''));

  if (flagged.length === 0) {
    body.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  body.innerHTML = flagged.slice(0, 10).map(h => `
    <tr>
      <td>${esc(fmtShortDate((h.actual_date || '').slice(0,10)))}</td>
      <td class="pm-cell-strong">${esc(h.machine_no || h.machine_name || '—')}</td>
      <td>${esc(h.pm_title || '—')}</td>
      <td>${pmResultPill(h.result)}</td>
      <td class="pm-muted" title="${esc(h.finding || '')}">${esc(h.finding || h.abnormal_detail || '—')}</td>
      <td class="pm-muted" title="${esc(h.action_taken || '')}">${esc(h.action_taken || '—')}</td>
      <td>${esc(h.technician_name || '—')}</td>
    </tr>`).join('');
}

function isDueSoon(dateStr) {
  if (!dateStr) return false;
  const due = new Date(dateStr);
  if (isNaN(due)) return false;
  const days = (due - new Date()) / 86400000;
  return days >= 0 && days <= 7;       // within a week
}

function pmStatusPill(status) {
  const s = String(status || '');
  if (s === 'Overdue')     return `<span class="pill pill--open">Overdue</span>`;
  if (s === 'In Progress') return `<span class="pill pill--prog">In Progress</span>`;
  if (s === 'Pending')     return `<span class="pill pill--neutral">Pending</span>`;
  if (s === 'Completed')   return `<span class="pill pill--done">Completed</span>`;
  return `<span class="pill pill--neutral">${esc(s || '—')}</span>`;
}

function pmResultPill(result) {
  const s = String(result || '');
  if (s === 'Abnormal Found')  return `<span class="pill pill--open">Abnormal</span>`;
  if (s === 'Need Follow-up')  return `<span class="pill pill--prog">Follow-up</span>`;
  if (s === 'Need Spare Part') return `<span class="pill pill--prog">Spare Part</span>`;
  if (s === 'Temporary Fixed') return `<span class="pill pill--prog">Temp Fix</span>`;
  return `<span class="pill pill--neutral">${esc(s || '—')}</span>`;
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
        <td>${techCell(r.technician_name, r.technician_code)}</td>
        <td>${statusPill(r.status)}</td>
      </tr>`;
  }).join('');
  body.innerHTML = rows;
}

/* render a technician as avatar (photo or initials) + name */
function techCell(name, code) {
  const display = name || '—';
  if (display === '—') return '<span class="tech-cell"><span class="tech-avatar tech-avatar--empty">?</span><span>—</span></span>';
  const t = findTech(name, code);
  const avatar = (t && t.photo_url)
    ? `<img class="tech-avatar" src="${esc(t.photo_url)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'tech-avatar tech-avatar--initials',textContent:'${esc(initials(display))}'}))">`
    : `<span class="tech-avatar tech-avatar--initials">${esc(initials(display))}</span>`;
  return `<span class="tech-cell">${avatar}<span class="tech-name">${esc(display)}</span></span>`;
}

/* initials from a Thai/English name — strip common Thai title prefixes */
function initials(name) {
  let n = String(name || '').trim();
  n = n.replace(/^(นาย|นาง|นางสาว|น\.ส\.|ด\.ช\.|ด\.ญ\.|Mr\.?|Ms\.?|Mrs\.?)\s*/i, '');
  const parts = n.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
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
  const pmTitles = ['ตรวจเช็คระดับน้ำมันไฮดรอลิก','ทำความสะอาดชุดทำความเย็น','หล่อลื่นแบริ่งมอเตอร์','ตรวจสอบเซ็นเซอร์ความดัน','ปรับตั้งสายพานลำเลียง','เปลี่ยนซีลกันรั่ว','ตรวจสภาพชุดแคลมป์','เช็คระบบลม'];
  const pmTypes = ['Inspection','Cleaning','Lubrication','Condition Check','Adjustment','Replacement','Safety Check','Inspection'];
  const planStatuses = ['Completed','Completed','Completed','Completed','Completed','Completed','Completed','Completed','Completed','Completed','Completed','Completed','Completed','In Progress','In Progress','Pending','Pending','Pending','Overdue','Overdue'];
  const plans = planStatuses.map((st, i) => ({
    id: i + 1,
    pm_no: 'PM-' + String(i + 1).padStart(3, '0'),
    machine_no: machines[i % machines.length].machine_no,
    machine_name: machines[i % machines.length].machine_name,
    pm_title: pmTitles[i % pmTitles.length],
    pm_type: pmTypes[i % pmTypes.length],
    planned_date: dayISO(i - 12),
    next_due_date: dayISO(i - 12),
    status: st
  }));

  // pm_history.result enum + follow_up_required boolean — include findings text
  const findings = [
    { result: 'Abnormal Found',  finding: 'พบรอยรั่วซึมที่ข้อต่อไฮดรอลิก',     action_taken: 'ขันแน่นชั่วคราว รอเปลี่ยนซีล' },
    { result: 'Need Follow-up',  finding: 'เสียงดังผิดปกติที่แบริ่ง',           action_taken: 'หล่อลื่นเพิ่ม นัดตรวจซ้ำสัปดาห์หน้า' },
    { result: 'Need Spare Part', finding: 'เซ็นเซอร์อ่านค่าคลาดเคลื่อน',         action_taken: 'สั่งเซ็นเซอร์ใหม่ รออะไหล่' },
    { result: 'Temporary Fixed', finding: 'สายพานหย่อนเกินพิกัด',              action_taken: 'ปรับความตึงชั่วคราว' },
    { result: 'Normal',          finding: '',                                  action_taken: '' }
  ];
  const history = Array.from({ length: 18 }, (_, i) => {
    const f = findings[i % 5];
    return {
      id: i + 1,
      pm_no: 'PM-' + String(i + 1).padStart(3, '0'),
      actual_date: dayISO(i),
      machine_no: machines[i % machines.length].machine_no,
      machine_name: machines[i % machines.length].machine_name,
      pm_title: pmTitles[i % pmTitles.length],
      status: f.result === 'Normal' ? 'Completed' : 'Need Follow-up',
      result: f.result,
      finding: f.finding,
      action_taken: f.action_taken,
      technician_name: ['Somchai','Wichai','Anan'][i % 3],
      follow_up_required: f.result === 'Need Follow-up'
    };
  });

  // sample technicians (no photos by default → initials avatars in preview)
  const technicians = [
    { id: 't1', employee_code: 'MVR-001', full_name: 'Somchai', position: 'Technician', photo_url: null, is_active: true },
    { id: 't2', employee_code: 'MVR-002', full_name: 'Wichai',  position: 'Technician', photo_url: null, is_active: true },
    { id: 't3', employee_code: 'MVR-003', full_name: 'Anan',    position: 'Senior Tech', photo_url: null, is_active: true }
  ];

  return { logs, machines, plans, history, technicians };
}
