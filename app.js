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

/* deck (page rotation) state */
const PAGE_COUNT = 5;
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
  renderGauge(kpis.availability);
  renderSnapshot(data);
  renderCharts(data);
  renderMachines(data.machines, data.logs);
  renderRiskForecast(data.logs, data.machines);
  renderPm(data);
  renderLogs(data.logs);
  renderExecutive(data);
}

/* Availability half-circle gauge */
function renderGauge(avail) {
  const fill = document.getElementById('availGaugeFill');
  const valEl = document.getElementById('availGaugeVal');
  const capEl = document.getElementById('availGaugeCap');
  if (!fill) return;

  const pct = Math.max(0, Math.min(100, avail || 0));
  const LEN = Math.PI * 80;                  // arc length ≈ 251.3
  fill.style.strokeDasharray = LEN;
  fill.style.strokeDashoffset = LEN - (LEN * pct) / 100;

  const color = pct >= 80 ? 'var(--green)' : (pct >= 70 ? 'var(--yellow)' : 'var(--red)');
  fill.style.stroke = color;
  valEl.style.color = color;
  valEl.innerHTML = fmtNum(pct, 1) + '<small>%</small>';
  capEl.textContent = pct >= 80 ? 'ดีเยี่ยม' : (pct >= 70 ? 'เฝ้าระวัง' : 'ต่ำกว่าเป้า');
}

/* Today snapshot tiles (always "today" regardless of period selector) */
function renderSnapshot(data) {
  const today = new Date().toISOString().slice(0, 10);
  const todayLogs = (data.logs || []).filter(r => (r.repair_date || '').slice(0, 10) === today);

  const jobs = todayLogs.length;
  const closed = todayLogs.filter(r => isStatusDone(r.status)).length;
  const open = jobs - closed;

  setText('snapJobs', fmtNum(jobs));
  setText('snapClosed', fmtNum(closed));
  setText('snapOpen', fmtNum(open));

  renderMeanDowntimePerDay(data.logs);
}

/* Mean Downtime per Day across the selected period, with a trend vs earlier half */
function renderMeanDowntimePerDay(logs) {
  const numEl = document.getElementById('snapMeanDt');
  const trendEl = document.getElementById('snapMeanTrend');
  if (!numEl) return;

  // sum loss per day
  const byDay = new Map();
  (logs || []).forEach(r => {
    const d = (r.repair_date || '').slice(0, 10);
    if (!d) return;
    byDay.set(d, (byDay.get(d) || 0) + lossOf(r));
  });

  const days = [...byDay.keys()].sort();
  if (days.length === 0) {
    numEl.textContent = '0';
    if (trendEl) trendEl.textContent = '';
    return;
  }

  const totalLoss = [...byDay.values()].reduce((s, v) => s + v, 0);
  const mean = totalLoss / days.length;        // avg per active day
  numEl.textContent = fmtNum(mean, 1);

  // trend: mean of recent half vs older half
  if (!trendEl) return;
  if (days.length < 4) { trendEl.className = 'snap-trend is-flat'; trendEl.textContent = '—'; return; }

  const mid = Math.floor(days.length / 2);
  const olderDays = days.slice(0, mid);
  const recentDays = days.slice(mid);
  const olderMean = olderDays.reduce((s, d) => s + byDay.get(d), 0) / olderDays.length;
  const recentMean = recentDays.reduce((s, d) => s + byDay.get(d), 0) / recentDays.length;

  const diffPct = olderMean === 0 ? 0 : ((recentMean - olderMean) / olderMean) * 100;

  if (Math.abs(diffPct) < 5) {
    trendEl.className = 'snap-trend is-flat';
    trendEl.innerHTML = `<span class="snap-trend__arrow">→</span> ทรงตัว`;
  } else if (diffPct > 0) {
    // downtime increased = worse
    trendEl.className = 'snap-trend is-up';
    trendEl.innerHTML = `<span class="snap-trend__arrow">▲</span> ${fmtNum(Math.abs(diffPct), 0)}% แย่ลง`;
  } else {
    // downtime decreased = better
    trendEl.className = 'snap-trend is-down';
    trendEl.innerHTML = `<span class="snap-trend__arrow">▼</span> ${fmtNum(Math.abs(diffPct), 0)}% ดีขึ้น`;
  }
}
function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }

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
    let m = map.get(name);
    if (!m) { m = { name, no: r.machine_no || '', total: 0 }; map.set(name, m); }
    m.total += lossOf(r);
  });
  return [...map.values()].sort((a, b) => b.total - a.total);
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

/* datalabels plugin: register globally but OFF by default;
   each chart opts in via options.plugins.datalabels */
if (window.ChartDataLabels) {
  Chart.register(window.ChartDataLabels);
  Chart.defaults.set('plugins.datalabels', { display: false });
}

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
  renderTopLossMini(data.logs);
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

  // identify key points: max, min, last
  const maxIdx = values.indexOf(Math.max(...values));
  const minIdx = values.indexOf(Math.min(...values));
  const lastIdx = values.length - 1;
  const keySet = new Set([maxIdx, minIdx, lastIdx]);

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
        pointRadius: (ctx) => keySet.has(ctx.dataIndex) ? 5 : 2.5,
        pointBackgroundColor: (ctx) => {
          if (ctx.dataIndex === maxIdx) return cssVar('--red') || '#e5604f';
          if (ctx.dataIndex === minIdx) return cssVar('--green') || '#34c178';
          return accentColor();
        },
        borderWidth: 2
      }]
    },
    options: {
      ...baseLineOptions(),
      layout: { padding: { top: 22 } },     // room for labels above points
      plugins: {
        legend: { display: false },
        datalabels: keyPointLabels(keySet, maxIdx, minIdx)
      }
    }
  });
}

/* datalabels config: show value only on key points (max/min/last) */
function keyPointLabels(keySet, maxIdx, minIdx) {
  return {
    display: (ctx) => keySet.has(ctx.dataIndex),
    align: 'top', anchor: 'end', offset: 4,
    color: (ctx) => {
      if (ctx.dataIndex === maxIdx) return cssVar('--red') || '#e5604f';
      if (ctx.dataIndex === minIdx) return cssVar('--green') || '#34c178';
      return cssVar('--text-mid') || '#aebcd2';
    },
    font: { size: 12, weight: 700 },
    formatter: (v) => fmtNum(v)
  };
}

/* Top 5 loss machine — horizontal bar */
function renderTopLoss(logs) {
  const top = aggregateDowntimeByMachine(logs).slice(0, 5);
  toggleEmpty('chartTopLoss', top.length === 0);

  drawChart('chartTopLoss', {
    type: 'bar',
    data: {
      labels: top.map(t => t.no || t.name),
      datasets: [{
        data: top.map(t => t.total),
        backgroundColor: accentColor(),
        borderRadius: 5,
        barThickness: 22
      }]
    },
    options: {
      indexAxis: 'y',
      ...baseBarOptions(),
      layout: { padding: { right: 42 } },
      plugins: {
        legend: { display: false },
        datalabels: barValueLabels('right')
      }
    }
  });
}

/* Compact Top-5 for the Overview page */
function renderTopLossMini(logs) {
  const top = aggregateDowntimeByMachine(logs).slice(0, 5);
  toggleEmpty('chartTopLossMini', top.length === 0);

  drawChart('chartTopLossMini', {
    type: 'bar',
    data: {
      labels: top.map(t => t.no || t.name),
      datasets: [{
        data: top.map(t => t.total),
        backgroundColor: top.map((t, i) => i === 0
          ? (cssVar('--red') || '#e5604f')
          : accentColor()),
        borderRadius: 5,
        barThickness: 18
      }]
    },
    options: {
      indexAxis: 'y',
      ...baseBarOptions(),
      layout: { padding: { right: 44 } },
      plugins: {
        legend: { display: false },
        datalabels: barValueLabels('right')
      }
    }
  });
}

/* datalabels for horizontal bars — value at the end of each bar */
function barValueLabels(align) {
  return {
    display: true,
    anchor: 'end', align: align || 'end', offset: 2,
    color: (ctx) => cssVar('--text-mid') || '#aebcd2',
    font: { size: 11.5, weight: 700 },
    formatter: (v) => fmtNum(v)
  };
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
      cutout: '60%',
      plugins: {
        legend: { position: 'right', labels: { color: cssVar('--text-mid'), font: { size: 11 }, boxWidth: 12, padding: 8 } },
        datalabels: {
          display: (ctx) => {
            // only label slices that are big enough to fit text
            const total = ctx.dataset.data.reduce((s, n) => s + n, 0) || 1;
            return (ctx.dataset.data[ctx.dataIndex] / total) >= 0.08;
          },
          color: '#fff',
          font: { size: 12, weight: 700 },
          formatter: (v, ctx) => {
            const total = ctx.dataset.data.reduce((s, n) => s + n, 0) || 1;
            return Math.round((v / total) * 100) + '%';
          }
        }
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
      x: { grid: { display: false }, ticks: { color: tickColor(), font: { size: 10 }, maxRotation: 0, autoSkip: true } },
      y: { beginAtZero: true, grid: { color: gridColor() }, ticks: { color: tickColor() } }
    }
  };
}
function baseBarOptions() {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
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
   BREAKDOWN RISK FORECAST
   Statistical risk scoring from repair history — no external AI.
   Score 0-100 weighted from: frequency, MTBF-due, trend, severity.
   ============================================================ */
function renderRiskForecast(logs, machines) {
  const grid = document.getElementById('riskGrid');
  const empty = document.getElementById('riskEmpty');
  if (!grid) return;

  const risks = computeRiskScores(logs, machines);

  if (risks.length === 0) {
    grid.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  grid.innerHTML = risks.slice(0, 8).map(r => {
    const cls = r.score >= 66 ? 'r-high' : (r.score >= 33 ? 'r-med' : 'r-low');
    const dueCls = r.overdue ? ' is-due' : '';
    const forecastTxt = r.overdue
      ? `<b>เลยรอบคาดการณ์แล้ว</b> ${Math.abs(r.daysToNext)} วัน — ควรตรวจ`
      : `คาดว่าเสียครั้งถัดไป <b>~${fmtShortDate(r.nextDate)}</b> (อีก ${r.daysToNext} วัน)`;

    return `
      <div class="risk-card ${cls}">
        <div class="risk-card__top">
          <div>
            <div class="risk-card__machine">${esc(r.no || r.name)}</div>
            <div class="risk-card__sub">${esc(r.name)} · ${esc(r.line || '—')}</div>
          </div>
          <div class="risk-score">
            <span class="risk-score__num">${r.score}</span>
            <span class="risk-score__lbl">Risk</span>
          </div>
        </div>
        <div class="risk-bar"><span style="width:${r.score}%"></span></div>
        <div class="risk-meta">
          <span class="risk-meta__item">เสีย <b>${r.count}</b> ครั้ง</span>
          <span class="risk-meta__item">MTBF <b>${fmtNum(r.mtbf)}</b> วัน</span>
          <span class="risk-meta__item">ซ่อมล่าสุด <b>${esc(fmtShortDate(r.lastDate))}</b></span>
        </div>
        <div class="risk-forecast${dueCls}">${forecastTxt}</div>
        <div class="risk-reason">${esc(r.reason)}</div>
      </div>`;
  }).join('');
}

/* Core scoring — returns machines ranked by risk (desc) */
function computeRiskScores(logs, machines) {
  // group logs per machine (need >= 2 to estimate an interval)
  const byMachine = new Map();
  (logs || []).forEach(r => {
    const key = r.machine_no || r.machine_name;
    if (!key) return;
    let m = byMachine.get(key);
    if (!m) {
      m = { no: r.machine_no || '', name: r.machine_name || key, line: r.production_line || '',
            dates: [], severities: [] };
      byMachine.set(key, m);
    }
    const d = (r.repair_date || '').slice(0, 10);
    if (d) m.dates.push(d);
    if (r.severity) m.severities.push(String(r.severity).toLowerCase());
  });

  const now = new Date();
  const results = [];
  let maxCount = 1;
  byMachine.forEach(m => { if (m.dates.length > maxCount) maxCount = m.dates.length; });

  byMachine.forEach(m => {
    if (m.dates.length < 2) return;            // not enough history to forecast
    m.dates.sort();
    const count = m.dates.length;

    // --- MTBF in days: average gap between consecutive breakdowns ---
    const gaps = [];
    for (let i = 1; i < m.dates.length; i++) {
      const g = daysBetween(m.dates[i - 1], m.dates[i]);
      if (g > 0) gaps.push(g);
    }
    const mtbf = gaps.length ? gaps.reduce((s, g) => s + g, 0) / gaps.length : 30;

    // --- days since last repair, and forecast next ---
    const lastDate = m.dates[m.dates.length - 1];
    const daysSince = daysBetween(lastDate, fmtDate(now));
    const daysToNext = Math.round(mtbf - daysSince);
    const overdue = daysToNext < 0;
    const nextDate = addDays(lastDate, Math.round(mtbf));

    // ===== Risk factors (each 0..1) =====
    // 1) frequency relative to the most-failing machine
    const fFreq = count / maxCount;

    // 2) how close to / past its own MTBF cycle
    const fDue = clamp01(daysSince / Math.max(mtbf, 1));

    // 3) trend: are failures getting more frequent? (2nd half vs 1st half)
    const fTrend = failureTrend(m.dates);

    // 4) severity: share of high/critical past issues
    const fSev = severityFactor(m.severities);

    const score = Math.round(100 * clamp01(
      0.35 * fFreq + 0.30 * fDue + 0.20 * fTrend + 0.15 * fSev
    ));

    results.push({
      no: m.no, name: m.name, line: m.line,
      count, mtbf: Math.round(mtbf), lastDate, daysToNext, overdue, nextDate,
      score,
      reason: buildRiskReason({ count, mtbf: Math.round(mtbf), daysSince, overdue, fTrend, fSev })
    });
  });

  return results.sort((a, b) => b.score - a.score);
}

/* trend factor: compare failure rate in recent half vs older half */
function failureTrend(sortedDates) {
  if (sortedDates.length < 4) return 0.4;     // too few to judge → neutral-ish
  const mid = Math.floor(sortedDates.length / 2);
  const firstHalf = sortedDates.slice(0, mid);
  const secondHalf = sortedDates.slice(mid);
  const spanFirst = Math.max(1, daysBetween(firstHalf[0], firstHalf[firstHalf.length - 1]));
  const spanSecond = Math.max(1, daysBetween(secondHalf[0], secondHalf[secondHalf.length - 1]));
  const rateFirst = firstHalf.length / spanFirst;
  const rateSecond = secondHalf.length / spanSecond;
  if (rateFirst === 0) return 0.6;
  const ratio = rateSecond / rateFirst;        // >1 means accelerating
  return clamp01((ratio - 0.5) / 1.5);         // map ~0.5..2.0 → 0..1
}

/* severity factor: fraction of high/critical incidents */
function severityFactor(sevs) {
  if (!sevs.length) return 0.3;
  const high = sevs.filter(s => s.includes('high') || s.includes('critical') || s.includes('สูง') || s.includes('วิกฤต')).length;
  return clamp01(high / sevs.length);
}

/* human-readable reason string (Thai) */
function buildRiskReason({ count, mtbf, daysSince, overdue, fTrend, fSev }) {
  const bits = [];
  if (overdue) bits.push('เลยรอบ MTBF แล้ว');
  else if (daysSince >= mtbf * 0.75) bits.push('ใกล้ครบรอบ MTBF');
  if (fTrend >= 0.6) bits.push('เสียถี่ขึ้นเรื่อยๆ');
  if (count >= 5) bits.push(`เสียบ่อย (${count} ครั้ง)`);
  if (fSev >= 0.5) bits.push('ความรุนแรงสูง');
  if (bits.length === 0) bits.push(`รอบเสียเฉลี่ย ${mtbf} วัน ยังไม่ถึงกำหนด`);
  return bits.join(' · ');
}

/* date helpers */
function fmtDate(d) { return d.toISOString().slice(0, 10); }
function daysBetween(a, b) {
  const da = new Date(a), db = new Date(b);
  if (isNaN(da) || isNaN(db)) return 0;
  return Math.round((db - da) / 86400000);
}
function addDays(dateStr, n) {
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}
function clamp01(v) { return Math.max(0, Math.min(1, v)); }

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
  renderPmTypeChart(plans);
  renderPmFreqChart(plans);
}

/* PM plans grouped by pm_type — horizontal bar */
function renderPmTypeChart(plans) {
  const map = new Map();
  (plans || []).forEach(p => {
    const t = p.pm_type || 'Other';
    map.set(t, (map.get(t) || 0) + 1);
  });
  const entries = [...map.entries()].sort((a, b) => b[1] - a[1]);
  toggleEmpty('chartPmType', entries.length === 0);

  drawChart('chartPmType', {
    type: 'bar',
    data: {
      labels: entries.map(e => e[0]),
      datasets: [{
        data: entries.map(e => e[1]),
        backgroundColor: accentColor(),
        borderRadius: 5,
        barThickness: 18
      }]
    },
    options: {
      indexAxis: 'y',
      ...baseBarOptions(),
      layout: { padding: { right: 34 } },
      plugins: {
        legend: { display: false },
        datalabels: barValueLabels('right')
      }
    }
  });
}

/* PM plans grouped by frequency — doughnut */
function renderPmFreqChart(plans) {
  // keep a sensible order if present
  const order = ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Yearly', 'Shutdown', 'AI Suggested'];
  const map = new Map();
  (plans || []).forEach(p => {
    const f = p.frequency || 'Other';
    map.set(f, (map.get(f) || 0) + 1);
  });
  const labels = [...map.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  const values = labels.map(l => map.get(l));
  toggleEmpty('chartPmFreq', labels.length === 0);

  const palette = ['#4f93d6', '#34c178', '#e6b54a', '#e5604f', '#8b7fd6', '#46b6c4', '#9aa7bd'];

  drawChart('chartPmFreq', {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: palette, borderColor: cssVar('--surface'), borderWidth: 2 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: '58%',
      plugins: {
        legend: { position: 'right', labels: { color: cssVar('--text-mid'), font: { size: 11 }, boxWidth: 12, padding: 7 } },
        datalabels: {
          display: (ctx) => {
            const total = ctx.dataset.data.reduce((s, n) => s + n, 0) || 1;
            return (ctx.dataset.data[ctx.dataIndex] / total) >= 0.09;
          },
          color: '#fff',
          font: { size: 11.5, weight: 700 },
          formatter: (v) => fmtNum(v)
        }
      }
    }
  });
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
   EXECUTIVE SUMMARY
   Management-level KPIs computed from existing data.
   ============================================================ */
function renderExecutive(data) {
  const logs = data.logs || [];
  const plans = data.plans || [];
  const hist = data.history || [];

  // ---- PM On-time %: completed PM done on/before due date ----
  const completedPm = hist.filter(h => h.status === 'Completed' || h.result === 'Completed' || h.result === 'Normal');
  let onTime = 0, pmConsidered = 0;
  completedPm.forEach(h => {
    const plan = plans.find(p => p.pm_no === h.pm_no);
    const due = (plan && (plan.next_due_date || plan.planned_date)) || h.next_due_date;
    const done = h.actual_date;
    if (due && done) {
      pmConsidered++;
      if (new Date(done) <= new Date(due)) onTime++;
    }
  });
  const pmOntimePct = pmConsidered ? (onTime / pmConsidered) * 100 : (completedPm.length ? 100 : 0);
  setExecKpi('execPmOntime', fmtNum(pmOntimePct, 1), bandHigher(pmOntimePct, 90, 75), pmOntimePct);

  // ---- First-Time Fix %: jobs whose machine+problem did NOT recur within the period ----
  const ftf = firstTimeFixRate(logs);
  setExecKpi('execFtf', fmtNum(ftf, 1), bandHigher(ftf, 85, 70), ftf);

  // ---- Repeat Failure %: share of breakdowns that are a repeat of same machine+problem ----
  const repeat = repeatFailureRate(logs);
  setExecKpi('execRepeat', fmtNum(repeat, 1), bandLower(repeat, 15, 30), repeat);

  // ---- Breakdown : PM ratio ----
  const bdCount = logs.length;
  const pmCount = hist.length;
  const ratio = pmCount ? bdCount / pmCount : (bdCount ? bdCount : 0);
  const ratioEl = document.getElementById('execRatio');
  if (ratioEl) {
    ratioEl.querySelector('[data-val]').textContent = pmCount ? (fmtNum(ratio, 1) + ' : 1') : '—';
    // lower ratio = more preventive = better. bar relative to a 3:1 worst-case.
    const barPct = Math.min(100, (ratio / 3) * 100);
    const cls = ratio <= 1 ? 'is-green' : (ratio <= 2 ? 'is-yellow' : 'is-red');
    ratioEl.classList.remove('is-green', 'is-yellow', 'is-red');
    ratioEl.classList.add(cls);
    const bar = ratioEl.querySelector('[data-bar]'); if (bar) bar.style.width = barPct + '%';
  }

  // ---- Top problems / causes ----
  renderRankList('execProblems', 'execProblemsEmpty', countBy(logs, 'problem_name'));
  renderRankList('execCauses', 'execCausesEmpty', countBy(logs, 'cause_name'));

  // ---- Technician workload ----
  renderWorkload(logs);
}

function firstTimeFixRate(logs) {
  if (logs.length === 0) return 0;
  // a "fix" recurs if the same machine+problem appears again on a later date
  const seen = new Map();   // key -> [dates]
  logs.forEach(r => {
    const key = (r.machine_no || r.machine_name || '') + '|' + (r.problem_name || '');
    const d = (r.repair_date || '').slice(0, 10);
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(d);
  });
  let recurring = 0, total = 0;
  seen.forEach(dates => {
    total += dates.length;
    if (dates.length > 1) recurring += dates.length;   // all occurrences of a recurring pair
  });
  // first-time-fix = jobs that did NOT belong to a recurring pair
  const fixedFirst = total - recurring;
  return total ? (fixedFirst / total) * 100 : 0;
}

function repeatFailureRate(logs) {
  if (logs.length === 0) return 0;
  const seen = new Map();
  logs.forEach(r => {
    const key = (r.machine_no || r.machine_name || '') + '|' + (r.problem_name || '');
    seen.set(key, (seen.get(key) || 0) + 1);
  });
  let repeats = 0;
  seen.forEach(n => { if (n > 1) repeats += (n - 1); });   // extra occurrences beyond first
  return (repeats / logs.length) * 100;
}

function countBy(logs, field) {
  const map = new Map();
  logs.forEach(r => {
    const v = r[field] || '—';
    map.set(v, (map.get(v) || 0) + 1);
  });
  return [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

function renderRankList(gridId, emptyId, items) {
  const grid = document.getElementById(gridId);
  const empty = document.getElementById(emptyId);
  if (!grid) return;
  if (!items || items.length === 0) { grid.innerHTML = ''; if (empty) empty.hidden = false; return; }
  if (empty) empty.hidden = true;

  const max = items[0].count || 1;
  grid.innerHTML = items.slice(0, 5).map((it, i) => `
    <div class="rank-item">
      <span class="rank-item__no">${i + 1}</span>
      <div class="rank-item__body">
        <div class="rank-item__top">
          <span class="rank-item__name" title="${esc(it.name)}">${esc(it.name)}</span>
          <span class="rank-item__val">${fmtNum(it.count)} ครั้ง</span>
        </div>
        <div class="rank-item__track"><span style="width:${(it.count / max) * 100}%"></span></div>
      </div>
    </div>`).join('');
}

function renderWorkload(logs) {
  const grid = document.getElementById('execWorkload');
  const empty = document.getElementById('execWorkloadEmpty');
  if (!grid) return;

  const map = new Map();
  logs.forEach(r => {
    const name = r.technician_name;
    if (!name) return;
    let t = map.get(name);
    if (!t) { t = { name, code: r.technician_code || '', jobs: 0, loss: 0 }; map.set(name, t); }
    t.jobs += 1;
    t.loss += lossOf(r);
  });
  const techs = [...map.values()].sort((a, b) => b.jobs - a.jobs);

  if (techs.length === 0) { grid.innerHTML = ''; if (empty) empty.hidden = false; return; }
  if (empty) empty.hidden = true;

  const maxJobs = techs[0].jobs || 1;
  grid.innerHTML = techs.slice(0, 6).map(t => {
    const tech = findTech(t.name, t.code);
    const avatar = (tech && tech.photo_url)
      ? `<img class="rank-tech-avatar" src="${esc(tech.photo_url)}" alt="">`
      : `<span class="rank-tech-avatar">${esc(initials(t.name))}</span>`;
    return `
      <div class="rank-item">
        ${avatar}
        <div class="rank-item__body">
          <div class="rank-item__top">
            <span class="rank-item__name" title="${esc(t.name)}">${esc(t.name)}</span>
            <span class="rank-item__val">${fmtNum(t.jobs)} งาน · ${fmtNum(t.loss)} min</span>
          </div>
          <div class="rank-item__track"><span style="width:${(t.jobs / maxJobs) * 100}%"></span></div>
        </div>
      </div>`;
  }).join('');
}

/* exec KPI helpers */
function setExecKpi(id, value, cls, barPct) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('is-green', 'is-yellow', 'is-red');
  if (cls) el.classList.add(cls);
  el.querySelector('[data-val]').textContent = value;
  const bar = el.querySelector('[data-bar]');
  if (bar) bar.style.width = Math.max(0, Math.min(100, barPct || 0)) + '%';
}
function bandHigher(v, green, yellow) { return v >= green ? 'is-green' : (v >= yellow ? 'is-yellow' : 'is-red'); }
function bandLower(v, green, yellow) { return v <= green ? 'is-green' : (v <= yellow ? 'is-yellow' : 'is-red'); }

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

  // extra history (older dates) so the risk forecast has enough per-machine data points.
  // Press P-11 = frequent & accelerating & high severity → should rank highest risk.
  const hist = [
    ['PRS-11','Press P-11','Line B', 7, 'Mechanical','High'],   ['PRS-11','Press P-11','Line B', 11,'Mechanical','High'],
    ['PRS-11','Press P-11','Line B', 16,'Mechanical','Critical'],['PRS-11','Press P-11','Line B', 23,'Mechanical','High'],
    ['INJ-02','Injection M-02','Line A', 9,'Electrical','Medium'],['INJ-02','Injection M-02','Line A', 17,'Electrical','High'],
    ['INJ-02','Injection M-02','Line A', 28,'Process','Medium'],
    ['RBT-03','Robot R-03','Line C', 12,'Electrical','High'],   ['RBT-03','Robot R-03','Line C', 26,'Electrical','Medium'],
    ['CNV-05','Conveyor C-05','Line B', 14,'Mechanical','Low'], ['CNV-05','Conveyor C-05','Line B', 27,'Mechanical','Low'],
    ['PKG-08','Packer K-08','Line C', 18,'Electrical','Medium'],['PKG-08','Packer K-08','Line C', 33,'Electrical','Low'],
    ['INJ-01','Injection M-01','Line A', 20,'Process','Low'],   ['INJ-01','Injection M-01','Line A', 40,'Process','Low']
  ];
  hist.forEach((h, i) => {
    logs.push({
      id: 100 + i, repair_date: dayISO(h[3]), shift: i % 2 ? 'A' : 'B',
      machine_name: h[1], machine_no: h[0], production_line: h[2],
      area_point_name: '—', problem_name: 'ความผิดปกติ', cause_name: 'สึกหรอตามอายุ',
      action_name: 'ซ่อม/เปลี่ยน', loss_time_min: 30 + (i * 7) % 60,
      technician_name: ['Somchai','Wichai','Anan'][i % 3],
      severity: h[5], status: 'Closed', breakdown_type: h[4]
    });
  });

  // pm_plans.status enum: Pending / In Progress / Completed / Overdue / Cancelled
  const pmTitles = ['ตรวจเช็คระดับน้ำมันไฮดรอลิก','ทำความสะอาดชุดทำความเย็น','หล่อลื่นแบริ่งมอเตอร์','ตรวจสอบเซ็นเซอร์ความดัน','ปรับตั้งสายพานลำเลียง','เปลี่ยนซีลกันรั่ว','ตรวจสภาพชุดแคลมป์','เช็คระบบลม'];
  const pmTypes = ['Inspection','Cleaning','Lubrication','Condition Check','Adjustment','Replacement','Safety Check','Inspection'];
  const pmFreqs = ['Monthly','Weekly','Monthly','Quarterly','Weekly','Yearly','Monthly','Daily'];
  const planStatuses = ['Completed','Completed','Completed','Completed','Completed','Completed','Completed','Completed','Completed','Completed','Completed','Completed','Completed','In Progress','In Progress','Pending','Pending','Pending','Overdue','Overdue'];
  const plans = planStatuses.map((st, i) => ({
    id: i + 1,
    pm_no: 'PM-' + String(i + 1).padStart(3, '0'),
    machine_no: machines[i % machines.length].machine_no,
    machine_name: machines[i % machines.length].machine_name,
    pm_title: pmTitles[i % pmTitles.length],
    pm_type: pmTypes[i % pmTypes.length],
    frequency: pmFreqs[i % pmFreqs.length],
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
