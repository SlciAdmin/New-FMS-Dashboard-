/* =====================================================================
   NDR MIS Dashboard — Google Sheet (Apps Script pipe) se live data + comments
   ===================================================================== */

const CONFIG = {
  SCRIPT_URL: "https://script.google.com/macros/s/AKfycbzGlAQw7vmWmjyB_YHERVipvug0Ab90lOt7NN3X6jWxJ84Lejv-sT3UgBVDKVm9_ZmE/exec",
  SCRIPT_KEY: "ndr-mis-8472-xyz",   // Code.gs wala SECRET_KEY (dono jagah same)
  DEFAULT_SHEET: "MIS-2025",
  REFRESH_SECONDS: 60,              // kitne second mein sheet dobara check ho
  DEFAULT_WEEK_RANGE: "2w",         // "2w" = 2 weeks (sheet jaisa), "4w", "2" = 2 mahine, "all"
};

/* ---------- state ---------- */
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const state = {
  sheet: store.get("mis_sheet") || CONFIG.DEFAULT_SHEET,
  data: null,
  signature: "",
  selectedEmp: "__ALL__",
  view: "sheet",
  sort: { col: null, dir: 1 },
  charts: {},
  timer: null,
  loading: false,
  edits: new Map(),       // "r:c" -> { r, c, area, value } (abhi save nahi hue)
  saving: false,
  saved: new Map(),       // "r:c" -> { r, c, value, at } (save ho gaye, sheet se confirm hone tak)
  reloadAfter: false,
  saveAgain: false,       // save chalte waqt aur values aayi: khatam hote hi dobara bhejo
  saveTimer: null,
  reloadTimer: null,
  noBatch: false,         // Code.gs purana deploy hai (batch "values" action nahi hai)
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* =====================================================================
   1. APPS SCRIPT CALLS
   ===================================================================== */

function scriptUrl(params) {
  const q = new URLSearchParams({ ...params, key: CONFIG.SCRIPT_KEY, _: Date.now() });
  return `${CONFIG.SCRIPT_URL}?${q.toString()}`;
}

async function callScript(params) {
  if (!CONFIG.SCRIPT_URL) throw new Error("script.js mein SCRIPT_URL khaali hai.");
  const url = scriptUrl(params);
  let json;
  try {
    const res = await fetch(url, { cache: "no-store" });
    json = await res.json();
  } catch (e) {
    console.warn("fetch failed, trying JSONP", e);
    try {
      json = await jsonp(url);
    } catch (e2) {
      throw new Error(
        `Apps Script se connect nahi hua (${e.message || e} / ${e2.message || e2}). Check karo:\n` +
        "1) Internet chal raha hai\n" +
        "2) SCRIPT_URL sahi hai aur '/exec' par khatam hota hai\n" +
        "3) Deploy settings: 'Execute as: Me', 'Who has access: Anyone'\n" +
        "4) Code.gs badla to 'New version' se dobara deploy kiya\n" +
        "5) Netlify / GitHub Pages par latest script.js deploy hai"
      );
    }
  }
  if (json.error) throw new Error(json.error);
  return json;
}

function jsonp(url, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const cb = "__mis_" + Math.random().toString(36).slice(2);
    const el = document.createElement("script");
    const done = (fn, v) => { clearTimeout(t); delete window[cb]; el.remove(); fn(v); };
    const t = setTimeout(() => done(reject, new Error("timeout")), timeout);
    window[cb] = (data) => done(resolve, data);
    el.onerror = () => done(reject, new Error("load failed"));
    el.src = `${url}&callback=${cb}`;
    document.head.appendChild(el);
  });
}

/* =====================================================================
   2. PARSE
   ===================================================================== */

function num(v) {
  if (v === null || v === undefined) return null;
  let s = String(v).trim();
  if (!s || s === "-" || s.startsWith("#")) return null;
  const pct = s.endsWith("%");
  s = s.replace(/[%,₹\s]/g, "");
  const n = Number(s);
  if (Number.isNaN(n)) return null;
  return pct ? n / 100 : n;
}
const clean = (v) => (v === null || v === undefined ? "" : String(v).replace(/\s+/g, " ").trim());

const MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
function parseDate(s) {
  s = clean(s);
  if (!s) return null;
  let m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]+)[\s,-]+(\d{2,4})$/);
  if (m) {
    const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    if (mi >= 0) return new Date(+(m[3].length === 2 ? "20" + m[3] : m[3]), mi, +m[1]);
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // m/d/yyyy
  if (m) return new Date(+m[3], +m[1] - 1, +m[2]);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) || !/\d/.test(s) ? null : d;
}

function parseGrid(grid, notesList = [], meta = {}) {
  const hidden = new Set(meta.hiddenCols || []);
  const notes = new Map(notesList.map(([r, c, t]) => [`${r}:${c}`, t]));

  let h = grid.findIndex((r, i) => i < 8 && r.some((c) => /result\s*in\s*area/i.test(clean(c))));
  if (h === -1) h = 2;
  const header = grid[h] || [];
  const weekRow = grid[h - 2] || [];
  const width = Math.max(...grid.slice(0, 50).map((r) => r.length), header.length);
  const find = (re, from = 0, to = width) => {
    for (let c = from; c < to; c++) if (re.test(clean(header[c]))) return c;
    return -1;
  };

  const areaCol = find(/result\s*in\s*area/i);
  let firstWeek = -1;
  for (let c = areaCol + 3; c < width; c++) {
    if (clean(weekRow[c]) && /not\s*done/i.test(clean(header[c]))) { firstWeek = c; break; }
  }
  const fixedEnd = firstWeek === -1 ? width : firstWeek;
  let teamCol = find(/^team$/i, 0, fixedEnd);
  if (teamCol === -1) teamCol = Math.max(0, areaCol - 1);
  const notDoneCol = find(/not\s*done/i, 0, fixedEnd);
  const actualCols = [];
  for (let c = 0; c < fixedEnd; c++) if (/^actual$/i.test(clean(header[c]))) actualCols.push(c);

  const cols = {
    team: teamCol, area: areaCol,
    emp: find(/^emp$/i, 0, fixedEnd),
    planned: find(/planned/i, 0, fixedEnd),
    actualDone: actualCols.find((c) => c < notDoneCol) ?? -1,
    doneByMe: find(/done\s*by\s*me/i, 0, fixedEnd),
    other: find(/^other$/i, 0, fixedEnd),
    notDonePct: notDoneCol,
    delayCount: actualCols.find((c) => c > notDoneCol) ?? -1,
    delayPct: find(/delay/i, 0, fixedEnd),
    link: find(/link/i, 0, fixedEnd),
  };

  const seen = {};
  const fixedHeaders = [];
  for (let c = 0; c < fixedEnd; c++) {
    let name = clean(header[c]) || `Col ${c + 1}`;
    if (c === cols.delayCount) name = "Delay count";
    if (seen[name]) name = `${name} (${++seen[name]})`; else seen[name] = 1;
    fixedHeaders.push(name);
  }

  const weeks = [];
  if (firstWeek !== -1) {
    for (let c = firstWeek; c + 3 < width; c += 4) {
      const raw = clean(weekRow[c]) || clean(weekRow[c + 1]);
      if (!raw && !clean(header[c])) break;
      const date = parseDate(raw);
      weeks.push({
        col: c, date,
        label: date ? date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" }) : raw || `W${weeks.length + 1}`,
      });
    }
  }

  // Team naam: sheet ke merged khaane ke hisaab se (jahan tak naam hai, bas wahi rows uski)
  const teamOf = [];
  const merges = meta.teamMerges || [];
  if (merges.length) {
    for (let r = h + 1; r < grid.length; r++) teamOf[r] = clean((grid[r] || [])[cols.team]);
    for (const [s0, e0] of merges) {
      const name = clean((grid[s0] || [])[cols.team]);
      for (let r = s0; r <= e0; r++) teamOf[r] = name;
    }
  } else {
    // purana Code.gs: fill-down
    let cur = "";
    for (let r = h + 1; r < grid.length; r++) {
      const t = clean((grid[r] || [])[cols.team]);
      if (t) cur = t;
      teamOf[r] = cur;
    }
  }

  const rows = [];
  for (let r = h + 1; r < grid.length; r++) {
    const g = grid[r] || [];
    const team = teamOf[r] || "";
    const area = clean(g[cols.area]);
    if (!area) continue;
    if (/^(team|result in area)$/i.test(area)) continue;
    const v = (c) => (c >= 0 ? num(g[c]) : null);
    const row = {
      gridRow: r,
      team, area,
      emp: v(cols.emp), planned: v(cols.planned), actualDone: v(cols.actualDone),
      doneByMe: v(cols.doneByMe), other: v(cols.other), notDonePct: v(cols.notDonePct),
      delayCount: v(cols.delayCount), delayPct: v(cols.delayPct),
      link: cols.link >= 0 && /^https?:/i.test(clean(g[cols.link])) ? clean(g[cols.link]) : "",
      raw: fixedHeaders.map((_, c) => clean(g[c])),
      weekly: weeks.map((w) => ({
        scoreNotDone: num(g[w.col]), scoreDelay: num(g[w.col + 1]),
        commitNotDone: num(g[w.col + 2]), commitDelay: num(g[w.col + 3]),
      })),
    };
    row.raw[cols.team] = team;
    rows.push(row);
  }

  const named = rows.filter((r) => r.team);   // bina naam wali rows kisi employee mein nahi judengi
  const byEmp = new Map();
  for (const row of named) {
    if (!byEmp.has(row.team)) byEmp.set(row.team, { name: row.team, rows: [] });
    byEmp.get(row.team).rows.push(row);
  }
  const employees = [...byEmp.values()].map((e) => ({ ...e, ...summarize(e.rows) }));

  // sheet jaise columns: hidden columns hata ke, sheet ke hi header naam
  const displayCols = [];
  for (let c = 0; c < fixedEnd; c++) if (!hidden.has(c)) displayCols.push({ c, h: clean(header[c]) || fixedHeaders[c] });

  return { cols, fixedHeaders, displayCols, weeks, rows, employees, notes, totals: summarize(named) };
}

function summarize(rows) {
  const s = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const planned = s("planned"), doneByMe = s("doneByMe"), actualDone = s("actualDone");
  const other = s("other"), delayCount = s("delayCount");
  const done = doneByMe || actualDone;
  return {
    areas: rows.length, planned, doneByMe, actualDone, other, delayCount,
    completion: planned ? done / planned : null,
    notDoneGap: planned ? Math.max(0, (planned - done) / planned) : null,
    delayRate: done ? delayCount / done : null,
  };
}

const noteAt = (r, c) => state.data?.notes.get(`${r}:${c}`) || "";

/* =====================================================================
   3. RENDER
   ===================================================================== */

const pct = (x, d = 0) => (x === null || x === undefined || Number.isNaN(x) ? "–" : `${(x * 100).toFixed(d)}%`);
const fmt = (x) => (x === null || x === undefined ? "–" : Number.isInteger(x) ? x.toLocaleString("en-IN") : x.toFixed(2));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
const tone = (c) => (c === null ? "" : c >= 0.9 ? "good" : c >= 0.7 ? "warn" : "bad");
const toneBar = (c) => (c === null ? "" : c >= 0.9 ? "" : c >= 0.7 ? "mid" : "low");

function renderAll() {
  if (!state.data) return;
  const at = cellPos(document.activeElement); // arrow keys se chuna hua cell render ke baad bhi chuna rahe
  renderRoster();
  renderOverview();
  if (state.selectedEmp !== "__ALL__") renderEmployee();
  renderSheetView();
  updateSaveBar();
  if (at) focusCell(at);
}

function kpiHTML(items) {
  return items.map((k) => `<div class="kpi ${k.tone || ""}"><div class="v">${k.v}</div><div class="l">${k.l}</div></div>`).join("");
}

/* ---- roster ---- */
function renderRoster() {
  const q = $("#empSearch").value.trim().toLowerCase();
  const sortBy = $("#empSort").value;
  const list = state.data.employees.filter((e) => e.name.toLowerCase().includes(q));
  list.sort({
    name: (a, b) => a.name.localeCompare(b.name),
    completion: (a, b) => (b.completion ?? -1) - (a.completion ?? -1),
    delay: (a, b) => (b.delayRate ?? -1) - (a.delayRate ?? -1),
    planned: (a, b) => b.planned - a.planned,
  }[sortBy]);

  const t = state.data.totals;
  $("#allMeta").innerHTML = `<span>${state.data.employees.length} employees</span><span>${pct(t.completion)} done</span>`;
  $(".roster-item.all").classList.toggle("active", state.selectedEmp === "__ALL__");
  $("#rosterList").innerHTML = list.length
    ? list.map((e) => `
      <button class="roster-item ${state.selectedEmp === e.name ? "active" : ""}" data-emp="${esc(e.name)}">
        <span class="r-name">${esc(e.name)}${empNoteCount(e) ? ` <span class="note-count" title="Comments">💬 ${empNoteCount(e)}</span>` : ""}</span>
        <span class="r-meta"><span>${fmt(e.doneByMe || e.actualDone)} / ${fmt(e.planned)} tasks</span><span>${pct(e.completion)}</span></span>
        <span class="bar ${toneBar(e.completion)}"><span style="width:${Math.min(100, (e.completion || 0) * 100)}%"></span></span>
      </button>`).join("")
    : `<p class="empty small">No employee matches "${esc(q)}".</p>`;
}

function empNoteCount(e) {
  let n = 0;
  for (const r of e.rows) for (const k of state.data.notes.keys()) if (k.startsWith(r.gridRow + ":")) n++;
  return n;
}

/* ---- overview ---- */
function renderOverview() {
  const d = state.data, t = d.totals;
  $("#kpis").innerHTML = kpiHTML([
    { v: d.employees.length, l: "Employees" },
    { v: fmt(t.planned), l: "Planned tasks" },
    { v: fmt(t.doneByMe || t.actualDone), l: "Done by self" },
    { v: fmt(t.other), l: "Done by others" },
    { v: pct(t.completion), l: "Completion", tone: tone(t.completion) },
    { v: pct(t.delayRate), l: "Delayed (of done)", tone: t.delayRate > 0.2 ? "bad" : t.delayRate > 0.05 ? "warn" : "good" },
  ]);

  renderPies("ov", d.rows.filter((r) => r.team));

  const worst = [...d.employees].filter((e) => e.notDoneGap !== null && e.planned > 0)
    .sort((a, b) => b.notDoneGap - a.notDoneGap).slice(0, 8);
  $("#worstList").innerHTML = worst.map((e) => `
    <li data-emp="${esc(e.name)}">
      <span class="rk-name">${esc(e.name)}</span>
      <span class="rk-val">${pct(e.notDoneGap)}</span>
      <span class="bar low"><span style="width:${e.notDoneGap * 100}%"></span></span>
    </li>`).join("") || `<li class="muted">No gaps. Everything planned is done.</li>`;

  const areas = new Map();
  for (const r of d.rows) { if (!areas.has(r.area)) areas.set(r.area, []); areas.get(r.area).push(r); }
  const areaRows = [...areas.entries()].map(([a, rs]) => ({ a, n: new Set(rs.map((r) => r.team)).size, ...summarize(rs) }))
    .filter((x) => x.planned > 0).sort((x, y) => y.planned - x.planned);
  $("#areaTable").innerHTML = `
    <thead><tr><th>Task area</th><th class="num">Employees</th><th class="num">Planned</th><th class="num">Done</th><th class="num">Delayed</th><th class="num">Completion</th></tr></thead>
    <tbody>${areaRows.map((x) => `
      <tr><td>${esc(x.a)}</td><td class="num">${x.n}</td><td class="num">${fmt(x.planned)}</td>
      <td class="num">${fmt(x.doneByMe || x.actualDone)}</td><td class="num">${fmt(x.delayCount)}</td>
      <td class="num"><span class="pill ${tone(x.completion)}">${pct(x.completion)}</span></td></tr>`).join("")}
    </tbody>`;
}

/* ---- employee report ---- */
function renderEmployee() {
  const e = state.data.employees.find((x) => x.name === state.selectedEmp);
  if (!e) { $("#empEmpty").hidden = false; $("#empReport").hidden = true; return; }
  $("#empEmpty").hidden = true; $("#empReport").hidden = false;

  $("#empName").textContent = e.name;
  $("#empSub").textContent = `${e.areas} task areas · sheet ${state.sheet}`;
  $("#empKpis").innerHTML = kpiHTML([
    { v: fmt(e.planned), l: "Planned" },
    { v: fmt(e.doneByMe || e.actualDone), l: "Done by self" },
    { v: fmt(e.other), l: "Done by others" },
    { v: pct(e.completion), l: "Completion", tone: tone(e.completion) },
    { v: fmt(e.delayCount), l: "Delayed tasks", tone: e.delayCount ? "warn" : "good" },
    { v: pct(e.delayRate), l: "Delay rate", tone: e.delayRate > 0.2 ? "bad" : e.delayRate > 0.05 ? "warn" : "good" },
  ]);

  renderPies("emp", e.rows);

  // Task areas: bilkul sheet jaise columns (Team ke bina)
  const d = state.data, ac = d.cols.area;
  const cols = d.displayCols.filter(({ c }) => c !== d.cols.team);
  $("#empTable").innerHTML = `
    <thead><tr>${cols.map(({ c, h }) => `<th class="${c === ac ? "" : "num"}">${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${e.rows.map((r) => `<tr>${cols.map(({ c }) => sheetCell(r, c, r.raw[c])).join("")}</tr>`).join("")}</tbody>`;

  renderWeekly(e);
  renderEmpComments(e);
}

function visibleWeeks() {
  const weeks = state.data.weeks;
  const range = $("#weekRange").value;
  let idx = weeks.map((_, i) => i);
  if (range === "all") return idx;
  const today = new Date();
  if (range.endsWith("w")) {
    // sheet jaisa: current week (aaj se pehle wala latest week) + agla week
    const n = parseInt(range, 10);
    let cur = -1;
    weeks.forEach((w, i) => { if (w.date && w.date <= today) cur = i; });
    if (cur === -1) cur = 0;
    const end = Math.min(weeks.length - 1, cur + 1);
    const start = Math.max(0, end - n + 1);
    return idx.slice(start, end + 1);
  }
  const from = new Date(today); from.setMonth(from.getMonth() - parseInt(range, 10));
  const to = new Date(today); to.setDate(to.getDate() + 7);
  return idx.filter((i) => weeks[i].date && weeks[i].date >= from && weeks[i].date <= to);
}

const METRICS = [
  { k: "scoreNotDone", off: 0, label: "Actual · Not done" },
  { k: "scoreDelay", off: 1, label: "Actual · Delay" },
  { k: "commitNotDone", off: 2, label: "Commitment · Not done" },
  { k: "commitDelay", off: 3, label: "Commitment · Delay" },
];

function renderWeekly(e) {
  const weeks = state.data.weeks;
  const idx = visibleWeeks();
  const onlyFilled = $("#onlyFilledRows").checked;
  $("#weekInfo").textContent = idx.length
    ? `${weeks[idx[0]].label} se ${weeks[idx[idx.length - 1]].label} tak · ${idx.length} weeks`
    : "Is range mein koi week nahi mila. Upar se 'All weeks' chuno.";

  if (!idx.length) { $("#weekTable").innerHTML = ""; return; }

  const rows = e.rows.filter((r) => !onlyFilled || idx.some((i) =>
    METRICS.some((m) => r.weekly[i][m.k] !== null || noteAt(r.gridRow, weeks[i].col + m.off))));

  const head1 = idx.map((i) => `<th colspan="4" class="wk">${esc(weeks[i].label)}</th>`).join("");
  const head2 = idx.map(() => `<th colspan="2" class="sub" title="Score">Actual</th><th colspan="2" class="sub wk-end">Commitment</th>`).join("");
  const head3 = idx.map(() => `<th>Not done</th><th>Delay</th><th>Not done</th><th class="wk-end">Delay</th>`).join("");

  $("#weekTable").innerHTML = `
    <thead>
      <tr><th rowspan="3" class="area">Task area</th>${head1}</tr>
      <tr>${head2}</tr>
      <tr>${head3}</tr>
    </thead>
    <tbody>${rows.map((r) => `<tr><th class="area">${esc(r.area)}</th>${idx.map((i) => METRICS.map((m) => {
      return weekCell(r, weeks[i].col + m.off, r.weekly[i][m.k], m.off === 3 ? "wk-end" : "");
    }).join("")).join("")}</tr>`).join("")}</tbody>`;
}

const fmtWeekVal = (v) => (Math.abs(v) < 1 && v !== 0 ? pct(v) : fmt(v));

/* ---- pie charts: Not done aur Delay, Actual vs Commitment ---- */
// weekly cell ko "kitna % not done" (0-100) mein: "-20" aur "-20%" dono = 20; plus wali value = 0
function notDoneOf(v) {
  if (v === null) return null;
  const p = Math.abs(v) < 1 ? v * 100 : v; // "-20%" num() se -0.2 aata hai
  return Math.min(100, Math.max(0, -p));
}

// chune hue weeks mein jitne cells bhare hain unka average not-done %
function avgNotDone(rows, k, idx = visibleWeeks()) {
  const vals = [];
  for (const r of rows) for (const i of idx) {
    const x = notDoneOf(r.weekly[i][k]);
    if (x !== null) vals.push(x);
  }
  return { n: vals.length, notDone: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null };
}

// do pie, sheet jaisa hisaab, dono mein Actual vs Commitment milake 100%:
//   Not done = pending / planned   (jaise UAN: 3 / 41 = 7%)
//   Delay    = delayed / done      (jaise UAN: 26 / 38 = 68%)
const PIES = [
  { k: "NotDone", title: "Not done", commit: "commitNotDone" },
  { k: "Delay", title: "Delay", commit: "commitDelay" },
];

// p = "ov" (overview) ya "emp" (employee report); rows = us scope ki task area rows
function renderPies(p, rows) {
  const box = $(`#${p}Pies`);
  if (!box.children.length) {
    box.innerHTML = PIES.map(({ k, title }) => `
      <div class="pie">
        <h3>${title}</h3>
        <p class="pie-calc" id="${p}${k}Calc"></p>
        <div class="pie-chart"><canvas id="${p}Pie${k}"></canvas><div class="pie-center" id="${p}${k}Center"></div></div>
        <ul class="pie-legend" id="${p}${k}Legend"></ul>
        <p class="pie-verdict" id="${p}${k}Verdict"></p>
      </div>`).join("") + `
      <div class="compare">
        <h3>Comparison: Actual vs Commitment</h3>
        <div class="chart-wrap"><canvas id="${p}Compare"></canvas></div>
      </div>
      <div class="compare">
        <h3>Week-wise Not done: Actual vs Commitment</h3>
        <p class="pie-calc">Actual = har Monday sheet ke Score · Not done mein apne aap bhara "Not Done"</p>
        <div class="chart-wrap"><canvas id="${p}WeekNotDone"></canvas></div>
      </div>
      <div class="compare">
        <h3>Week-wise Delay: Actual vs Commitment</h3>
        <p class="pie-calc">Actual = har Monday sheet ke Score · Delay mein apne aap bhara "Delay%"</p>
        <div class="chart-wrap"><canvas id="${p}WeekDelay"></canvas></div>
      </div>`;
    $(`#${p}Area`).addEventListener("change", () => (p === "ov" ? renderOverview() : renderEmployee()));
  }

  // task area chuno: sab ya ek (jaise UAN N M)
  const sel = $(`#${p}Area`), want = sel.value;
  const areas = [...new Set(rows.filter((r) => r.planned > 0).map((r) => r.area))];
  sel.innerHTML = `<option value="">All task areas</option>` + areas.map((a) => `<option>${esc(a)}</option>`).join("");
  sel.value = areas.includes(want) ? want : "";
  const use = sel.value ? rows.filter((r) => r.area === sel.value) : rows;

  const weeks = state.data.weeks, idx = visibleWeeks();
  $(`#${p}PieInfo`).textContent = idx.length
    ? `Commitment: ${weeks[idx[0]].label}${idx.length > 1 ? " – " + weeks[idx[idx.length - 1]].label : ""}`
    : "Is week range mein koi week nahi";

  const t = summarize(use);
  const done = t.doneByMe || t.actualDone || 0, pending = Math.max(0, (t.planned || 0) - done);
  const show = (v) => (v === null ? "–" : pct(v / 100, 1));
  const actual = {
    NotDone: t.notDoneGap === null ? null : t.notDoneGap * 100,
    Delay: t.delayRate === null ? null : t.delayRate * 100,
  };
  const calc = {
    NotDone: t.planned ? `Planned ${fmt(t.planned)} · Done ${fmt(done)} · Pending ${fmt(pending)} → ${fmt(pending)} ÷ ${fmt(t.planned)} = <b>${show(actual.NotDone)}</b>` : "Koi planned task nahi",
    Delay: done ? `Done ${fmt(done)} · Delayed ${fmt(t.delayCount)} → ${fmt(t.delayCount)} ÷ ${fmt(done)} = <b>${show(actual.Delay)}</b>` : "Koi done task nahi",
  };

  const bars = { actual: [], commit: [] };
  for (const { k, commit } of PIES) {
    const com = avgNotDone(use, commit);
    bars.actual.push(actual[k]);
    bars.commit.push(com.notDone);
    const slices = [
      { label: "Actual", v: actual[k], color: "#b4372f", sub: k === "NotDone" ? `${fmt(pending)} / ${fmt(t.planned)} tasks` : `${fmt(t.delayCount)} / ${fmt(done)} tasks` },
      { label: "Commitment", v: com.notDone, color: "#c27c12", sub: com.n ? `${fmt(com.n)} entries ka average` : "koi entry nahi" },
    ];
    const total = slices.reduce((a, s) => a + (s.v || 0), 0);
    const has = slices.every((s) => s.v !== null) && total > 0; // dono value chahiye, warna 100/0 galat dikhega
    for (const s of slices) s.share = has ? ((s.v || 0) / total) * 100 : null;

    drawChart(`${p}Pie${k}`, {
      type: "doughnut",
      data: {
        labels: has ? slices.map((s) => s.label) : ["No data"],
        datasets: [{
          data: has ? slices.map((s) => s.share) : [1],
          backgroundColor: has ? slices.map((s) => s.color) : ["#e3e7ee"],
          borderColor: "#fff", borderWidth: 2,
        }],
      },
      options: {
        cutout: "62%",
        plugins: {
          legend: { display: false },
          tooltip: { enabled: has, callbacks: { label: (ctx) => `${ctx.label}: ${show(ctx.raw)} (value ${show(slices[ctx.dataIndex].v)})` } },
        },
      },
    });

    $(`#${p}${k}Calc`).innerHTML = calc[k];
    $(`#${p}${k}Center`).innerHTML = has
      ? `<b class="bad">${show(slices[0].share)}</b><span>Actual</span><b class="warn small-b">${show(slices[1].share)}</b><span>Commitment</span><span class="pie-total">= 100%</span>`
      : `<b class="bad">${show(actual[k])}</b><span>Actual</span><span>Commitment: ${com.n ? "–" : "koi entry nahi"}</span>`;
    $(`#${p}${k}Legend`).innerHTML = slices.map((s) =>
      `<li><i style="background:${s.color}"></i><span>${s.label}<small>value ${show(s.v)} · ${esc(s.sub)}</small></span><b>${show(s.share)}</b></li>`).join("")
      + (has ? `<li class="pie-sum"><span>Total (dono milake)</span><b>100%</b></li>` : "");

    const v = $(`#${p}${k}Verdict`), a = actual[k], c = com.notDone;
    if (a === null || c === null) {
      v.className = "pie-verdict";
      v.textContent = a === null ? "Actual nikalne ke liye data nahi hai." : "Is week range mein Commitment ke cells khaali hain.";
    } else {
      const gap = a - c; // plus = commitment se zyada kharab
      v.className = `pie-verdict ${gap > 0.5 ? "bad" : "good"}`;
      v.textContent = gap > 0.5 ? `Actual commitment se ${pct(gap / 100, 1)} zyada hai.`
        : gap < -0.5 ? `Actual commitment se ${pct(-gap / 100, 1)} kam hai. Commitment se behtar.`
        : "Actual aur commitment barabar hain.";
    }
  }

  // bar chart: Not done vs Commitment not done, Delay vs Commitment delay (bar ke upar % likha)
  drawChart(`${p}Compare`, {
    type: "bar",
    data: {
      labels: ["Not done vs Commitment not done", "Delay vs Commitment delay"],
      datasets: [
        { label: "Actual", data: bars.actual, backgroundColor: "#b4372f", borderRadius: 4, maxBarThickness: 80 },
        { label: "Commitment", data: bars.commit, backgroundColor: "#c27c12", borderRadius: 4, maxBarThickness: 80 },
      ],
    },
    options: {
      layout: { padding: { top: 24 } },
      scales: { y: { ticks: { callback: (v) => v + "%" } } },
      plugins: { tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${show(ctx.raw)}` } } },
    },
    plugins: [barLabels(show)],
  });

  // week-wise: har week ka Actual (Score, Monday ko bhara) vs us week ki Commitment
  for (const [id, a, c] of [["WeekNotDone", "scoreNotDone", "commitNotDone"], ["WeekDelay", "scoreDelay", "commitDelay"]]) {
    drawChart(`${p}${id}`, {
      type: "bar",
      data: {
        labels: idx.map((i) => weeks[i].label),
        datasets: [
          { label: "Actual", data: idx.map((i) => avgNotDone(use, a, [i]).notDone), backgroundColor: "#b4372f", borderRadius: 4, maxBarThickness: 48 },
          { label: "Commitment", data: idx.map((i) => avgNotDone(use, c, [i]).notDone), backgroundColor: "#c27c12", borderRadius: 4, maxBarThickness: 48 },
        ],
      },
      options: {
        layout: { padding: { top: 24 } },
        scales: { y: { ticks: { callback: (v) => v + "%" } } },
        plugins: { tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.raw === null ? "koi entry nahi" : show(ctx.raw)}` } } },
      },
      plugins: [barLabels(show)],
    });
  }
}

// har bar ke upar uski value likho (khaali value par "koi entry nahi")
function barLabels(show) {
  return {
    id: "barLabels",
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      ctx.save();
      ctx.font = "700 13px Figtree, sans-serif";
      ctx.textAlign = "center";
      const n = chart.data.labels.length;
      if (n > 12) { ctx.restore(); return; } // bahut weeks: labels ek doosre par chadhenge, tooltip kaafi hai
      chart.data.datasets.forEach((ds, i) => chart.getDatasetMeta(i).data.forEach((bar, j) => {
        const v = ds.data[j];
        if (v === null && n > 4) return;
        ctx.fillStyle = v === null ? "#667085" : "#1c2536";
        ctx.fillText(v === null ? "koi entry nahi" : show(v), bar.x, (v === null ? chart.scales.y.bottom : bar.y) - 6);
      }));
      ctx.restore();
    },
  };
}

function renderEmpComments(e) {
  const d = state.data;
  const byRow = new Map(e.rows.map((r) => [r.gridRow, r]));
  const items = [];
  for (const [key, text] of d.notes) {
    const [r, c] = key.split(":").map(Number);
    const row = byRow.get(r);
    if (!row) continue;
    items.push({ r, c, text, ctx: cellContext(row, c) });
  }
  $("#empComments").innerHTML = items.length
    ? items.map((it) => `
      <li data-r="${it.r}" data-c="${it.c}">
        <div class="cm-ctx">${esc(it.ctx)}</div>
        <div class="cm-text">${esc(it.text)}</div>
      </li>`).join("")
    : `<li class="muted">Abhi koi comment nahi hai.</li>`;
}

function cellContext(row, c) {
  const d = state.data;
  if (c === d.cols.area) return `${row.area} · overall`;
  const w = d.weeks.find((w) => c >= w.col && c < w.col + 4);
  if (w) return `${row.area} · ${w.label} · ${METRICS[c - w.col].label}`;
  return `${row.area} · ${d.fixedHeaders[c] || "Col " + (c + 1)}`;
}

/* ---- ek fixed cell sheet jaisa ---- */
function sheetCell(r, c, value, extra = "") {
  const d = state.data;
  const n = num(value);
  const isPct = c === d.cols.notDonePct || c === d.cols.delayPct;
  const note = noteAt(r.gridRow, c);
  const cls = [
    c === d.cols.team ? "st-team" : "", c === d.cols.area ? "st-area" : "",
    isPct && n !== null ? (n === 0 ? "ok" : n < 0 ? "bad" : "") : "",
    n !== null && c !== d.cols.team && c !== d.cols.area ? "num" : "",
    note ? "has-note" : "", extra,
  ].join(" ");
  const content = /^https?:\/\//i.test(value) ? `<a href="${esc(value)}" target="_blank" rel="noopener">Click Here</a>` : esc(value);
  return `<td class="${cls}" data-r="${r.gridRow}" data-c="${c}"${note ? ` title="${esc(note)}"` : ""}>${content}</td>`;
}

/* ---- ek weekly (Score / Commitment) cell: click karke value likho ---- */
const origValue = (v) => (v === null ? "" : fmtWeekVal(v).replace(/,/g, ""));

function weekCell(r, c, v, extra = "") {
  const edit = state.edits.get(`${r.gridRow}:${c}`);
  const note = noteAt(r.gridRow, c);
  const shown = edit ? edit.value : origValue(v);
  const n = edit ? num(edit.value) : v;
  const cls = [n === null ? "" : n === 0 ? "ok" : "bad", note ? "has-note" : "", edit ? "edited" : "", edit && edit.sending ? "sending" : "", edit && edit.error ? "err" : "", "editable", extra].join(" ");
  const title = edit && edit.error ? edit.error : edit ? "Sheet mein save ho raha hai…" : note || "Click karke value likho";
  return `<td class="${cls}" data-r="${r.gridRow}" data-c="${c}" data-orig="${esc(origValue(v))}" tabindex="0" title="${esc(title)}">${esc(shown)}</td>`;
}

/* ---- sheet view (Google Sheet jaisa) ---- */
function sheetRows() {
  const d = state.data;
  const q = $("#sheetSearch").value.trim().toLowerCase();
  let rows = d.rows.filter((r) => state.selectedEmp === "__ALL__" || r.team === state.selectedEmp);
  if ($("#hideEmpty").checked) rows = rows.filter((r) => (r.planned || 0) > 0 || r.raw.some((v, c) => c > d.cols.area && num(v)));
  if (q) rows = rows.filter((r) => (r.team + " " + r.raw.join(" ")).toLowerCase().includes(q));
  return rows;
}

function renderSheetView() {
  const d = state.data;
  const idx = visibleWeeks();
  const rows = sheetRows();
  state.visibleRows = rows;
  const weeks = d.weeks;
  const fixed = d.displayCols;

  $("#sheetCount").textContent =
    `${rows.length} rows${state.selectedEmp !== "__ALL__" ? ` · ${state.selectedEmp}` : ""}` +
    (idx.length ? ` · weeks: ${weeks[idx[0]].label}${idx.length > 1 ? " – " + weeks[idx[idx.length - 1]].label : ""}` : "");

  // Delay% tak ke columns freeze: har fixed column ko fx-<n> class, left position baad mein naap ke
  const fxCls = (k) => `fx fx-${k}${k === fixed.length - 1 ? " fx-last" : ""}`;
  const head1 = fixed.map(({ h, c }, k) =>
    `<th rowspan="3" class="${fxCls(k)} ${c === d.cols.team ? "st-team" : c === d.cols.area ? "st-area" : ""}">${esc(h)}</th>`).join("")
    + idx.map((i) => `<th colspan="4" class="wk wk-end">${esc(weeks[i].label)}</th>`).join("");
  const head2 = idx.map(() => `<th colspan="2" class="sub" title="Score">Actual</th><th colspan="2" class="sub wk-end">Commitment</th>`).join("");
  const head3 = idx.map(() => `<th>Not done</th><th>Delay</th><th>Not done</th><th class="wk-end">Delay</th>`).join("");

  let prevTeam = "";
  const body = rows.map((r) => {
    const first = r.team !== prevTeam;
    prevTeam = r.team;
    const cells = fixed.map(({ c }, k) => sheetCell(r, c, c === d.cols.team ? (first ? r.team : "") : r.raw[c], fxCls(k))).join("");
    const wk = idx.map((i) => METRICS.map((m) => {
      return weekCell(r, weeks[i].col + m.off, r.weekly[i][m.k], (m.off === 3 ? "wk-end " : "") + "wcell");
    }).join("")).join("");
    return `<tr class="${first ? "grp" : ""}">${cells}${wk}</tr>`;
  }).join("");

  $("#sheetTable").innerHTML = `
    <thead><tr>${head1}</tr><tr>${head2}</tr><tr>${head3}</tr></thead>
    <tbody>${body || `<tr><td class="muted" colspan="20">Koi row nahi mili.</td></tr>`}</tbody>`;
  freezeFixedCols();
}

// fixed columns ki chaudai naap ke har ek ka sticky "left" set karo.
// Team se "Delay%" column tak hamesha freeze; Link aur weeks scroll.
function freezeFixedCols() {
  const ths = [...document.querySelectorAll("#sheetTable thead th.fx")];
  if (!ths.length || !ths[0].offsetWidth) return; // tab chhupa hai, dikhne par dobara
  const delayK = ths.findIndex((th) => /delay/i.test(th.textContent));
  const upto = delayK >= 0 ? delayK : ths.length - 1;
  let left = 0, last = -1;
  const css = ths.map((th, k) => {
    const w = th.offsetWidth;
    // freeze nahi: cell normal scroll kare aur frozen columns ke PEECHE jaaye (upar nahi);
    // header ka top-sticky bana rahe par frozen header se neeche layer mein
    if (k > upto)
      return `#sheetTable td.fx-${k}{position:relative;z-index:auto}\n#sheetTable th.fx-${k}{left:auto;z-index:2}`;
    const rule = `#sheetTable .fx-${k}{left:${left}px}`;
    left += w; last = k;
    return rule;
  });
  if (last >= 0) css.push(`#sheetTable .fx-${last}{border-right:2px solid #b9c3d3;box-shadow:4px 0 6px -4px rgba(28,37,54,.25)}`);
  let el = document.getElementById("fxStyle");
  if (!el) { el = document.createElement("style"); el.id = "fxStyle"; document.head.appendChild(el); }
  el.textContent = css.join("\n");
}

function downloadCSV() {
  const d = state.data, rows = state.visibleRows || d.rows, idx = visibleWeeks();
  const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const wkHead = idx.flatMap((i) => METRICS.map((m) => `${d.weeks[i].label} ${m.label}`));
  const csv = [
    [...d.fixedHeaders, ...wkHead].map(q).join(","),
    ...rows.map((r) => [...r.raw, ...idx.flatMap((i) => METRICS.map((m) => r.weekly[i][m.k] ?? ""))].map(q).join(",")),
  ].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `${state.sheet}-${state.selectedEmp === "__ALL__" ? "all" : state.selectedEmp}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---- charts ---- */
function drawChart(id, cfg) {
  if (typeof Chart === "undefined") return;
  if (!document.getElementById(id).offsetWidth) return; // tab chhupa hai: khulne par switchView dobara banata hai
  const base = {
    responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
    plugins: { legend: { position: "bottom", labels: { boxWidth: 12, font: { family: "Figtree" } } } },
    ...(cfg.type === "doughnut" ? {} : { scales: { y: { beginAtZero: true, grid: { color: "#eef1f5" } }, x: { grid: { display: false } } } }),
  };
  cfg.options = deepMerge(base, cfg.options || {});
  if (state.charts[id] && state.charts[id].config.type !== cfg.type) {
    state.charts[id].destroy();
    delete state.charts[id];
  }
  if (state.charts[id]) {
    state.charts[id].data = cfg.data;
    state.charts[id].options = cfg.options;
    state.charts[id].update();
  } else {
    state.charts[id] = new Chart(document.getElementById(id), cfg);
  }
}
function deepMerge(a, b) {
  const o = { ...a };
  for (const k in b) o[k] = b[k] && typeof b[k] === "object" && !Array.isArray(b[k]) ? deepMerge(a[k] || {}, b[k]) : b[k];
  return o;
}

/* =====================================================================
   4. INLINE EDIT (sheet ke cell mein seedha value) + SAVE
   ===================================================================== */

/* ---- Excel jaisa keyboard: ↑ ↓ ← → se cell badlo, number type karo to seedha likhna shuru ---- */
// cell ki pehchaan (table + sheet row + col): render ke baad naya <td> isi se dhoondhte hain
function cellPos(el) {
  const td = el?.closest?.("td.editable");
  const table = td?.closest("table");
  return td && table?.id ? { table: table.id, r: td.dataset.r, c: td.dataset.c } : null;
}

// dir = up | down | left | right: us taraf ka agla likhne wala cell (koi nahi to null)
function neighborCell(td, dir) {
  if (dir === "left" || dir === "right") {
    let x = td;
    do x = dir === "left" ? x.previousElementSibling : x.nextElementSibling;
    while (x && !x.matches("td.editable"));
    return x;
  }
  let tr = td.parentElement;
  while ((tr = dir === "up" ? tr.previousElementSibling : tr.nextElementSibling)) {
    const x = tr.querySelector(`td.editable[data-c="${td.dataset.c}"]`);
    if (x) return x;
  }
  return null;
}

function focusCell(pos) {
  const td = document.querySelector(`#${pos.table} td.editable[data-r="${pos.r}"][data-c="${pos.c}"]`);
  if (!td) return null;
  td.focus({ preventScroll: true });
  revealCell(td);
  return td;
}

// cell ko table ke dikhne wale hisse mein lao: frozen (sticky) columns aur header ke peeche na chhupe
function revealCell(td) {
  const wrap = td.closest(".table-wrap");
  if (!wrap) return td.scrollIntoView({ block: "nearest", inline: "nearest" });
  const box = wrap.getBoundingClientRect(), cell = td.getBoundingClientRect();
  let left = box.left, top = box.top;
  for (const x of td.parentElement.cells) {
    if (x !== td && getComputedStyle(x).position === "sticky") left = Math.max(left, x.getBoundingClientRect().right);
  }
  const head = td.closest("table").tHead;
  if (head) top = Math.max(top, head.getBoundingClientRect().bottom);
  const right = box.left + wrap.clientWidth, bottom = box.top + wrap.clientHeight;
  if (cell.left < left) wrap.scrollLeft -= left - cell.left;
  else if (cell.right > right) wrap.scrollLeft += cell.right - right;
  if (cell.top < top) wrap.scrollTop -= top - cell.top;
  else if (cell.bottom > bottom) wrap.scrollTop += cell.bottom - bottom;
  const page = td.getBoundingClientRect(); // table khud screen se bahar ho to page bhi scroll karo
  if (page.top < 0 || page.bottom > innerHeight) td.scrollIntoView({ block: "nearest" });
}

const ARROWS = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };

// chune hue (focus wale) cell par key: arrows = cell badlo, Enter/F2 = edit, number = naya likho, Delete = khaali karo
function cellKeydown(e) {
  const td = e.target;
  if (!td.matches?.("td.editable") || e.ctrlKey || e.metaKey || e.altKey) return;
  if (ARROWS[e.key]) {
    e.preventDefault();
    const next = neighborCell(td, ARROWS[e.key]);
    if (next) focusCell(cellPos(next));
  } else if (e.key === "Tab") {
    const next = neighborCell(td, e.shiftKey ? "left" : "right");
    if (next) { e.preventDefault(); focusCell(cellPos(next)); }
  } else if (e.key === "Enter" || e.key === "F2") {
    e.preventDefault();
    startEdit(td);
  } else if (/^[\d.%-]$/.test(e.key)) {
    e.preventDefault();
    startEdit(td, { text: e.key });
  } else if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    startEdit(td, { text: "" });
  }
}

// opts.text: Excel jaisa "type karke likhna" (purani value hata kar ye text, ← → se cell badalta hai);
// bina text (click / Enter / F2) = purani value edit karo (← → se cursor chalta hai)
function startEdit(td, opts = {}) {
  if (td.querySelector("input")) return; // save peeche chalta rahe, aap agla cell bharte raho
  const r = Number(td.dataset.r), c = Number(td.dataset.c);
  const pos = cellPos(td);
  const typing = opts.text !== undefined;
  const edit = state.edits.get(`${r}:${c}`);
  const input = document.createElement("input");
  input.className = "cell-in";
  input.inputMode = "decimal";
  input.value = typing ? opts.text : edit ? edit.value : td.dataset.orig;
  td.textContent = "";
  td.appendChild(input);
  input.focus();
  if (typing) input.setSelectionRange(input.value.length, input.value.length);
  else input.select();

  let done = false;
  // move = up|down|left|right: save karke us taraf ka cell chuno; "stay" = isi cell par raho; null = mouse se bahar gaye
  const finish = (keep, move = null) => {
    if (done) return;
    done = true;
    const next = move && move !== "stay" ? cellPos(neighborCell(td, move)) : null;
    if (keep) setEdit(r, c, input.value.trim(), td.dataset.orig);
    renderAll();
    if (move) focusCell(next || pos);
    // value likhte hi sheet mein save (thodi der jama karke ek request mein; Save button sirf fail hue cells ke liye)
    const edit = state.edits.get(`${r}:${c}`);
    if (keep && edit && !edit.error) queueSave();
  };
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("keydown", (e) => {
    const dir = ARROWS[e.key];
    if (e.key === "Enter") { e.preventDefault(); finish(true, e.shiftKey ? "up" : "down"); }
    else if (e.key === "Tab") { e.preventDefault(); finish(true, e.shiftKey ? "left" : "right"); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false, "stay"); }
    else if (dir === "up" || dir === "down" || (dir && typing)) { e.preventDefault(); finish(true, dir); }
  });
}

function setEdit(r, c, value, orig) {
  const key = `${r}:${c}`;
  const prev = state.edits.get(key);
  // purani value wapas likhi aur koi save raaste mein nahi = kuch bhejna nahi
  if (value === orig && !(prev && prev.sending)) { state.edits.delete(key); return; }
  if (value !== "" && !/^-?\d+(\.\d+)?%?$/.test(value)) {
    toast("Sirf number likho (jaise 0, 5, -18).");
    return;
  }
  const row = state.data.rows.find((x) => x.gridRow === r);
  state.edits.set(key, { r, c, area: row ? row.area : "", value });
}

function updateSaveBar() {
  const failed = [...state.edits.values()].filter((e) => e.error).length;
  $("#saveBar").hidden = failed === 0;
  $("#saveBtn").textContent = state.saving ? "Saving…" : `Retry (${failed})`;
  $("#saveBtn").disabled = state.saving;
}

// jaldi-jaldi bhari values ko 400ms jama karke ek hi request mein bhejo
function queueSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveEdits, 400);
}

// formula wale cells (Delay% waghera) update karne ke liye: aakhri save ke 3 sec baad chupchaap ek reload
function queueReload() {
  clearTimeout(state.reloadTimer);
  state.reloadTimer = setTimeout(() => {
    state.signature = "";
    if (state.loading || state.saving) state.reloadAfter = true;
    else load({ silent: true });
  }, 3000);
}

// table dobara banao, lekin agar user kisi cell mein likh raha hai to uska input mat todo (finish khud render karega)
function renderIfIdle() {
  if (document.activeElement?.classList.contains("cell-in")) return;
  renderAll();
}

async function sendBatch(batch) {
  const items = batch.map((e) => ({ row: e.r, col: e.c, area: e.area, value: e.value }));
  if (!state.noBatch) {
    const res = await callScript({ action: "values", sheet: state.sheet, areaCol: state.data.cols.area, items: JSON.stringify(items) });
    if (Array.isArray(res.results)) return res.results;
    state.noBatch = true; // Code.gs abhi purana deploy hai: ek-ek cell wala tareeka
  }
  const out = [];
  for (const it of items) {
    try {
      const res = await callScript({ action: "value", sheet: state.sheet, row: it.row, col: it.col, areaCol: state.data.cols.area, area: it.area, value: it.value });
      out.push({ ok: true, value: res.value });
    } catch (err) {
      out.push({ error: err.message });
    }
  }
  return out;
}

// retry = true: Save/Retry button se, fail hue cells bhi dobara bhejo
async function saveEdits(retry = false) {
  if (state.saving) { state.saveAgain = true; return; }
  const batch = [...state.edits.entries()].filter(([, e]) => !e.sending && (retry || !e.error));
  if (!batch.length) return;
  state.saving = true;
  for (const [, e] of batch) { e.sending = true; delete e.error; }
  updateSaveBar();

  let results;
  try {
    results = await sendBatch(batch.map(([, e]) => e));
  } catch (err) {
    results = batch.map(() => ({ error: err.message }));
  }

  let fail = 0, lastErr = "";
  batch.forEach(([key, e], i) => {
    const res = results[i] || { error: "Sheet se jawab nahi aaya" };
    e.sending = false;
    if (res.error) { e.error = res.error; lastErr = res.error; fail++; return; }
    state.saved.set(key, { r: e.r, c: e.c, value: res.value ?? e.value, at: Date.now() });
    // beech mein user ne isi cell mein nayi value likh di ho to wo edit rehne do (wo agle batch mein jaayegi)
    if (state.edits.get(key) === e) state.edits.delete(key);
  });

  state.saving = false;
  applySaved(state.data);
  renderIfIdle();
  updateSaveBar();
  if (fail) toast(`${fail} value save nahi hui: ${lastErr.split("\n")[0]}`);
  else setSync("live", `Saved · ${new Date().toLocaleTimeString("en-IN")}`);

  // save ke dauraan nayi values aa gayi ho to unhe turant bhejo, warna reload schedule karo
  const more = [...state.edits.values()].some((e) => !e.sending && !e.error);
  if (state.saveAgain || more) { state.saveAgain = false; saveEdits(); }
  else queueReload();
}

// save hui values dashboard par turant dikhao; jab tak sheet se aaya data unhe confirm na kare
// (purana/beech mein chala load unhe mita na de), 2 minute tak upar se lagao
function applySaved(d) {
  if (!d) return;
  for (const [key, s] of state.saved) {
    const row = d.rows.find((x) => x.gridRow === s.r);
    const wi = d.weeks.findIndex((w) => s.c >= w.col && s.c < w.col + 4);
    if (!row || wi === -1) { state.saved.delete(key); continue; }
    const k = METRICS[s.c - d.weeks[wi].col].k;
    const want = num(s.value);
    if (row.weekly[wi][k] === want || Date.now() - s.at > 120000) { state.saved.delete(key); continue; }
    row.weekly[wi][k] = want;
  }
}

/* =====================================================================
   5. LOAD + AUTO REFRESH
   ===================================================================== */

async function load({ silent = false } = {}) {
  if (state.loading) return;
  if (silent && (state.saving || document.activeElement?.classList.contains("cell-in"))) return;
  state.loading = true;
  setSync("loading", silent ? "Checking sheet for changes…" : "Loading sheet… (5-10 sec)");
  try {
    const res = await callScript({ action: "get", sheet: state.sheet });
    const sig = hash(JSON.stringify([res.values, res.notes]));
    const changed = state.signature && sig !== state.signature;
    if (sig !== state.signature) {
      state.data = parseGrid(res.values || [], res.notes || [], { hiddenCols: res.hiddenCols, teamMerges: res.teamMerges });
      applySaved(state.data);
      state.signature = state.saved.size ? "" : sig; // abhi confirm nahi hua to agli baar bhi dobara parse
      if (!state.data.rows.length) {
        showError(`"${state.sheet}" tab mein Team / Result in area ke neeche koi data nahi mila. Upar dropdown se doosra tab chuno.`);
      } else hideError();
      if (state.selectedEmp !== "__ALL__" && !state.data.employees.some((e) => e.name === state.selectedEmp)) {
        state.selectedEmp = "__ALL__";
      }
      renderAll();
      if (changed && silent) {
        toast("Sheet updated. Dashboard refreshed.");
        $(".main").classList.add("flash");
        setTimeout(() => $(".main").classList.remove("flash"), 1600);
      }
    }
    setSync("live", `Live · synced ${new Date().toLocaleTimeString("en-IN")} · every ${CONFIG.REFRESH_SECONDS}s`);
  } catch (err) {
    console.error(err);
    setSync("error", "Sync failed");
    showError(err.message);
  } finally {
    state.loading = false;
    if (state.reloadAfter) { state.reloadAfter = false; load({ silent: true }); }
  }
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(h);
}
function startTimer() {
  clearInterval(state.timer);
  state.timer = setInterval(() => { if (!document.hidden) load({ silent: true }); }, CONFIG.REFRESH_SECONDS * 1000);
}
function setSync(kind, text) { $("#syncDot").className = `dot ${kind}`; $("#syncText").textContent = text; }
function showError(msg) { const b = $("#errorBox"); b.textContent = msg; b.hidden = false; }
function hideError() { $("#errorBox").hidden = true; }
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 2800); }

/* =====================================================================
   6. EVENTS
   ===================================================================== */

function selectEmployee(name) {
  state.selectedEmp = name;
  renderRoster();
  renderSheetView();
  if (state.view === "sheet") return;        // sheet view mein sirf filter
  if (name === "__ALL__") switchView("overview");
  else { renderEmployee(); switchView("employee"); }
}

function switchView(v) {
  state.view = v;
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === v));
  $$(".view").forEach((s) => s.classList.toggle("active", s.id === `view-${v}`));
  if (v === "overview" && state.data) renderOverview();
  if (v === "employee" && state.data) renderEmployee();
  if (v === "sheet") freezeFixedCols();
  Object.values(state.charts).forEach((c) => c.resize());
}

function bind() {
  $("#sheetSelect").value = state.sheet;
  $("#sheetSelect").addEventListener("change", (e) => {
    state.sheet = e.target.value;
    store.set("mis_sheet", state.sheet);
    state.signature = ""; state.selectedEmp = "__ALL__";
    load();
  });
  $("#weekRange").value = store.get("mis_weeks") || CONFIG.DEFAULT_WEEK_RANGE;
  $("#weekRange").addEventListener("change", (e) => {
    store.set("mis_weeks", e.target.value);
    renderSheetView();
    renderOverview();
    if (state.selectedEmp !== "__ALL__") renderEmployee();
  });
  $("#onlyFilledRows").addEventListener("change", renderEmployee);
  $("#hideEmpty").addEventListener("change", renderSheetView);
  $("#sheetSearch").addEventListener("input", renderSheetView);

  $("#refreshBtn").addEventListener("click", () => { state.signature = ""; load(); });
  $("#empSearch").addEventListener("input", renderRoster);
  $("#empSort").addEventListener("change", renderRoster);
  $(".roster").addEventListener("click", (e) => {
    const b = e.target.closest("[data-emp]");
    if (b) selectEmployee(b.dataset.emp);
  });
  $("#worstList").addEventListener("click", (e) => {
    const li = e.target.closest("[data-emp]");
    if (li) selectEmployee(li.dataset.emp);
  });
  $$(".tab").forEach((t) => t.addEventListener("click", () => switchView(t.dataset.view)));
  $("#downloadCsv").addEventListener("click", downloadCSV);

  // weekly cell par click = wahi value likho
  const editFrom = (e) => {
    const td = e.target.closest("td.editable");
    if (td) startEdit(td);
  };
  for (const id of ["#weekTable", "#sheetTable"]) {
    $(id).addEventListener("click", editFrom);
    $(id).addEventListener("keydown", cellKeydown);
  }
  $("#saveBtn").addEventListener("mousedown", (e) => e.preventDefault()); // input blur pehle ho jaaye, click na khoye
  $("#saveBtn").addEventListener("click", () => { document.activeElement?.blur?.(); saveEdits(true); });
  window.addEventListener("resize", freezeFixedCols);
  window.addEventListener("beforeunload", (e) => { if (state.edits.size) { e.preventDefault(); e.returnValue = ""; } });

  document.addEventListener("visibilitychange", () => { if (!document.hidden) load({ silent: true }); });
}

if (typeof module !== "undefined") module.exports = { parseGrid, parseDate };

if (typeof document !== "undefined") {
  bind();
  load();
  startTimer();
}