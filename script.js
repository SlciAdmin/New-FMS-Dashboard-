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
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  remove(k) { try { localStorage.removeItem(k); } catch {} },
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
  loading: false,         // jis sheet ka load chal raha hai (naam), warna false
  cache: {},              // sheet naam -> aakhri "get" response
  fresh: new Set(),       // is visit mein jin sheets ka data sheet se aa chuka hai
  prefetching: false,
  edits: new Map(),       // "r:c" -> { r, c, area, value } (abhi save nahi hue)
  saving: false,
  saved: new Map(),       // "r:c" -> { r, c, value, at } (save ho gaye, sheet se confirm hone tak)
  reloadAfter: false,
  saveAgain: false,       // save chalte waqt aur values aayi: khatam hote hi dobara bhejo
  saveTimer: null,
  reloadTimer: null,
  noBatch: false,
  sheetToEnd: true,       // sheet table ko latest week (right side) tak scroll karna hai         // Code.gs purana deploy hai (batch "values" action nahi hai)
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
      // sheet mein jaisa dikhta hai waisa hi text ("-100%", "-150%"), taaki dashboard par bhi same dikhe
      weeklyText: weeks.map((w) => ({
        scoreNotDone: clean(g[w.col]), scoreDelay: clean(g[w.col + 1]),
        commitNotDone: clean(g[w.col + 2]), commitDelay: clean(g[w.col + 3]),
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

// KPI card ka chhota icon: label ke shabd dekh ke (Delay pehle, kyunki "Delayed (of done)" mein done bhi hai)
const KPI_ICONS = [
  [/delay/i, '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/>'],
  [/employee/i, '<path d="M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1"/><circle cx="9" cy="7" r="3.5"/><path d="M22 19v-1a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>'],
  [/planned/i, '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>'],
  [/others/i, '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>'],
  [/done/i, '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>'],
  [/completion/i, '<path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 7v5l3 2"/><path d="M21 3v6h-6"/>'],
];
function kpiHTML(items) {
  return items.map((k) => {
    const icon = k.icon || (KPI_ICONS.find(([re]) => re.test(k.l)) || [])[1] || KPI_ICONS[1][1];
    return `<div class="kpi ${k.tone || ""}">
      <span class="kpi-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg></span>
      <div><div class="v">${k.v}</div><div class="l">${k.l}</div></div>
    </div>`;
  }).join("");
}

/* ---- employee dropdown (upar, sheet wali dropdown ke paas) ---- */
// employee search: list khulti hai, naam type karo to sirf milte naam bachte hain
function renderRoster() {
  const d = state.data, t = d.totals;
  const list = [...d.employees].sort((a, b) => a.name.localeCompare(b.name));
  state.empOptions = [
    { value: "__ALL__", label: `All employees (${list.length})`, meta: `${pct(t.completion)} done` },
    ...list.map((e) => ({ value: e.name, label: e.name, meta: `${pct(e.completion)} done` })),
  ];
  const inp = $("#empSearch");
  if (document.activeElement !== inp) inp.value = empLabel();
  if (!$("#empList").hidden) renderEmpList();
}

const empLabel = () => {
  const o = (state.empOptions || []).find((x) => x.value === state.selectedEmp);
  return o ? `${o.label} · ${o.meta}` : "";
};

// list banao: type kiya hai to sirf milte naam, mila hua hissa highlight
function renderEmpList() {
  const q = state.empFiltering ? $("#empSearch").value.trim().toLowerCase() : "";
  const items = (state.empOptions || []).filter((o) => !q || o.label.toLowerCase().includes(q));
  state.empItems = items;
  state.empActive = Math.max(0, Math.min(state.empActive || 0, items.length - 1));
  const mark = (s) => {
    const i = q ? s.toLowerCase().indexOf(q) : -1;
    return i < 0 ? esc(s) : esc(s.slice(0, i)) + "<mark>" + esc(s.slice(i, i + q.length)) + "</mark>" + esc(s.slice(i + q.length));
  };
  $("#empList").innerHTML = items.length
    ? items.map((o, i) => `<li role="option" data-v="${esc(o.value)}" class="${i === state.empActive ? "active" : ""}${o.value === state.selectedEmp ? " sel" : ""}"
        aria-selected="${o.value === state.selectedEmp}"><span>${mark(o.label)}</span><small>${o.meta}</small></li>`).join("")
    : `<li class="none">"${esc(q)}" naam ka koi employee nahi mila</li>`;
  const act = $("#empList li.active");
  if (act) act.scrollIntoView({ block: "nearest" });
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
      return weekCell(r, weeks[i].col + m.off, r.weekly[i][m.k], m.off === 3 ? "wk-end" : "", r.weeklyText[i][m.k]);
    }).join("")).join("")}</tr>`).join("")}</tbody>`;
}

const fmtWeekVal = (v) => (Math.abs(v) < 1 && v !== 0 ? pct(v) : fmt(v));

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
const origValue = (v, text = "") => (v === null ? "" : (text || fmtWeekVal(v)).replace(/,/g, ""));

function weekCell(r, c, v, extra = "", text = "") {
  const edit = state.edits.get(`${r.gridRow}:${c}`);
  const note = noteAt(r.gridRow, c);
  const shown = edit ? edit.value : origValue(v, text);
  const n = edit ? num(edit.value) : v;
  const cls = [n === null ? "" : n === 0 ? "ok" : "bad", note ? "has-note" : "", edit ? "edited" : "", edit && edit.sending ? "sending" : "", edit && edit.error ? "err" : "", "editable", extra].join(" ");
  const title = edit && edit.error ? edit.error : edit ? "Sheet mein save ho raha hai…" : note || "Click karke value likho";
  return `<td class="${cls}" data-r="${r.gridRow}" data-c="${c}" data-orig="${esc(origValue(v, text))}" tabindex="0" title="${esc(title)}">${esc(shown)}</td>`;
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
  // ek employee chuna hai to Team column mein wahi naam baar baar aata, isliye hata do
  const fixed = state.selectedEmp === "__ALL__" ? d.displayCols : d.displayCols.filter(({ c }) => c !== d.cols.team);

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
      return weekCell(r, weeks[i].col + m.off, r.weekly[i][m.k], (m.off === 3 ? "wk-end " : "") + "wcell", r.weeklyText[i][m.k]);
    }).join("")).join("");
    return `<tr class="${first ? "grp" : ""}">${cells}${wk}</tr>`;
  }).join("");

  $("#sheetTable").innerHTML = `
    <thead><tr>${head1}</tr><tr>${head2}</tr><tr>${head3}</tr></thead>
    <tbody>${body || `<tr><td class="muted" colspan="20">Koi row nahi mili.</td></tr>`}</tbody>`;
  freezeFixedCols();
  syncHScroll();
  renderSheetHist();
}

// neeche wala scrollbar (screen ke bottom par chipka rehta hai) table ki chaudai ke saath milao;
// naya employee / range / sheet chuna ho to latest week (right side) tak le jao, 60 sec refresh par jagah wahi rahe
function syncHScroll() {
  const w = $(".sheet-wrap"), bar = $("#sheetHScroll");
  if (!w.offsetWidth) return; // tab chhupa hai, dikhne par switchView dobara bulata hai
  bar.firstElementChild.style.width = w.scrollWidth + "px";
  bar.style.marginRight = w.offsetWidth - w.clientWidth + "px";
  if (state.sheetToEnd) { w.scrollLeft = w.scrollWidth; state.sheetToEnd = false; }
  bar.scrollLeft = w.scrollLeft;
}

/* ---- sheet view ke upar: weekly ke chaar graph (purana Planned vs Actual bar graph hata diya) ---- */
function renderSheetHist() {
  renderTrend(); // All employees par bhi (sabka jod)
}

/* ---- Planned vs Actual ke neeche: chune weeks ka bar graph, Not Done vs Delay (kitne task) ----
   Sheet (aur Book12.xlsx) jaisa hisaab: har week ke Not Done / Delay column mein jitne cells
   0 se kam hain (-10, -100% ...) utne task = COUNTIF(<0). 0 = kaam theek hua, khaali cell = entry nahi. */
const TR_ICONS = {
  tasks: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  nd: '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>',
  dl: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/>',
  perf: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
};

// aaj tak ka aakhri week (visibleWeeks jaisa)
function currentWeek() {
  const today = new Date();
  let cur = -1;
  state.data.weeks.forEach((w, i) => { if (w.date && w.date <= today) cur = i; });
  return cur === -1 ? state.data.weeks.length - 1 : cur;
}

// filter ki halat: sheet badle to dobara default (aakhri 4 week, aaj tak)
function trendState() {
  const n = state.data.weeks.length;
  let t = state.trend;
  const range = $("#weekRange").value;
  if (!t || t.sheet !== state.sheet || t.end >= n || t.range !== range) {
    const vis = visibleWeeks();
    const start = vis.length ? vis[0] : 0, end = vis.length ? vis[vis.length - 1] : Math.max(0, n - 1);
    t = state.trend = { sheet: state.sheet, range, start, end, off: new Set() };
  }
  return t;
}

function trendSelected() {
  const t = trendState(), idx = [];
  for (let i = t.start; i <= t.end; i++) if (!t.off.has(i)) idx.push(i);
  return idx;
}

function renderTrendFilters() {
  const d = state.data, t = trendState();
  const names = d.employees.map((e) => e.name).sort((a, b) => a.localeCompare(b));
  $("#trEmp").innerHTML = `<option value="__ALL__">All employees (${names.length})</option>` + names.map((n) => `<option>${esc(n)}</option>`).join("");
  $("#trEmp").value = state.selectedEmp;
  const opts = d.weeks.map((w, i) => `<option value="${i}">Week ${i + 1} · ${esc(w.label)}</option>`).join("");
  $("#trStart").innerHTML = opts; $("#trEnd").innerHTML = opts;
  $("#trStart").value = t.start; $("#trEnd").value = t.end;
  $("#trWeeks").innerHTML = d.weeks.slice(t.start, t.end + 1).map((w, k) => {
    const i = t.start + k;
    return `<label class="tr-chip"><input type="checkbox" value="${i}"${t.off.has(i) ? "" : " checked"} /> Week ${i + 1} <small>${esc(w.label)}</small></label>`;
  }).join("") || `<span class="muted small">Is range mein koi week nahi</span>`;
}

/* ---- chaar line graph, sab ka X axis = week ki date, Y axis = kitne task ----
   1) Planned (hara) vs Actual (laal)   2) Actual Delay   3) Commitment Not Done   4) Commitment Delay
   Planned = us week jin task mein koi bhi entry hai; Actual = Actual (Score) Not Done < 0 nahi (kaam hua).
   Not Done / Delay = us column mein 0 se kam wale cells (COUNTIF <0), khaali = entry nahi. */
function renderTrend() {
  const d = state.data;
  renderTrendFilters();
  const all = state.selectedEmp === "__ALL__";
  const who = all ? "All employees" : state.selectedEmp;
  const empRows = d.rows.filter((r) => r.team && (all || r.team === state.selectedEmp)); // har row ek task
  // Task dropdown: chune employee ke tasks (Result in area); "All tasks" = sab jod ke
  const taskNames = [...new Set(empRows.map((r) => r.area).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (!taskNames.includes(state.trTask)) state.trTask = "__ALL__";
  $("#trTask").innerHTML = `<option value="__ALL__">All tasks (${taskNames.length})</option>` + taskNames.map((n) => `<option>${esc(n)}</option>`).join("");
  $("#trTask").value = state.trTask;
  const oneTask = state.trTask !== "__ALL__";
  const rows = oneTask ? empRows.filter((r) => r.area === state.trTask) : empRows;
  const idx = trendSelected();
  const neg = (v) => v !== null && v < 0;

  // har week: kitne task + un tasks ke naam (tooltip mein dikhane ke liye)
  const pts = idx.map((i) => {
    const names = { plan: [], act: [], aDl: [], cNd: [], cDl: [] };
    for (const r of rows) {
      const w = r.weekly[i];
      const hasScore = w.scoreNotDone !== null || w.scoreDelay !== null;
      if (!hasScore && w.commitNotDone === null && w.commitDelay === null) continue;
      const area = (all && r.team ? `${r.area} (${r.team})` : r.area) || "(no name)";
      names.plan.push(area);
      if (hasScore && !neg(w.scoreNotDone)) names.act.push(area);
      if (neg(w.scoreDelay)) names.aDl.push(area);
      if (neg(w.commitNotDone)) names.cNd.push(area);
      if (neg(w.commitDelay)) names.cDl.push(area);
    }
    const plan = names.plan.length, has = plan > 0, n = (k) => (has ? names[k].length : null);
    return { i, label: d.weeks[i].label, names, plan, act: n("act"), aDl: n("aDl"), cNd: n("cNd"), cDl: n("cDl") };
  });
  const have = pts.filter((p) => p.plan);
  const sum = (k) => have.reduce((s, p) => s + p[k], 0);
  const tot = { plan: sum("plan"), act: sum("act"), aDl: sum("aDl"), cNd: sum("cNd"), cDl: sum("cDl") };
  const share = (v, of) => (of ? `${+((v / of) * 100).toFixed(1)}%` : "–");

  $("#trInfo").textContent = `${who} · ${idx.length} week${idx.length === 1 ? "" : "s"}`;
  $("#trKpis").innerHTML = kpiHTML([
    { v: fmt(tot.plan), l: "Planned tasks", icon: TR_ICONS.tasks },
    { v: `${fmt(tot.act)} <small class="kpi-pct">${share(tot.act, tot.plan)}</small>`, l: "Actual done", icon: TR_ICONS.perf, tone: tot.plan ? (tot.act < tot.plan ? "warn" : "good") : "" },
    { v: `${fmt(tot.aDl)} <small class="kpi-pct">${share(tot.aDl, tot.plan)}</small>`, l: "Actual Delay", icon: TR_ICONS.dl, tone: tot.plan ? (tot.aDl ? "warn" : "good") : "" },
    { v: `${fmt(tot.cNd)} <small class="kpi-pct">${share(tot.cNd, tot.plan)}</small>`, l: "Commitment Not Done", icon: TR_ICONS.nd, tone: tot.plan ? (tot.cNd ? "bad" : "good") : "" },
    { v: `${fmt(tot.cDl)} <small class="kpi-pct">${share(tot.cDl, tot.plan)}</small>`, l: "Commitment Delay", icon: TR_ICONS.dl, tone: tot.plan ? (tot.cDl ? "warn" : "good") : "" },
  ]);

  const GREEN = "#2f9e4f", RED = "#d64541", ORANGE = "#ed7d31", PURPLE = "#7b4fc9";
  // Graph (hath ke sketch jaisa): X axis par har task ka ek group -> us task ke chune hue weeks
  // (Week 1, Week 2 ...) aur group ke neeche task ka naam; Y axis = 0-100%.
  // Sheet ke % cell (-10% = 10% not done / delay) seedhe %, 0 se kam nahi.
  const taskLabel = oneTask ? state.trTask : "All tasks";
  const asPct = (r, i, k) => {
    const v = r.weekly[i][k];
    if (v === null) return null;
    return /%/.test(r.weeklyText[i][k]) || Math.abs(v) < 1 ? v * 100 : v; // "-10%" / -0.1 = -10, "-10" = -10
  };
  const pctOf = (r, i, k) => { const v = asPct(r, i, k); return v === null ? null : v < 0 ? Math.round(-v * 10) / 10 : 0; };
  const tasks = [];
  for (const r of rows) {
    const name = all ? `${r.area} (${r.team})` : r.area;
    let g = tasks.find((x) => x.name === name);
    if (!g) tasks.push((g = { name, rows: [] }));
    g.rows.push(r);
  }
  tasks.sort((a, b) => a.name.localeCompare(b.name));
  // X axis: har week mein har task ka ek point (neeche task ka naam khada, 90°),
  // tasks ke neeche week + date; poori line lagataar, weeks ke beech koi tukda / divider nahi
  const slots = [], groups = [];
  idx.forEach((i, wi) => {
    const wk = { name: `Week ${wi + 1} · ${d.weeks[i].label}`, from: slots.length };
    for (const g of tasks) {
      const vals = { plan: null, act: null, aDl: null, cNd: null, cDl: null };
      for (const r of g.rows) {
        const w = r.weekly[i];
        const hasScore = w.scoreNotDone !== null || w.scoreDelay !== null;
        if (!hasScore && w.commitNotDone === null && w.commitDelay === null) continue;
        vals.plan = 100;
        const done = hasScore ? Math.max(0, Math.round((100 - (pctOf(r, i, "scoreNotDone") || 0)) * 10) / 10) : null;
        const mx = (k, v) => { if (v !== null) vals[k] = Math.max(vals[k] ?? 0, v); };
        mx("act", done); mx("aDl", pctOf(r, i, "scoreDelay")); mx("cNd", pctOf(r, i, "commitNotDone")); mx("cDl", pctOf(r, i, "commitDelay"));
      }
      slots.push({ g, i, n: wi + 1, label: d.weeks[i].label, vals });
    }
    wk.to = slots.length - 1;
    groups.push(wk);
  });

  const short = (t) => (t.length > 26 ? t.slice(0, 25).trimEnd() + "…" : t);
  const labels = slots.map((s) => (s ? short(s.g.name) : ""));
  const line = (label, k, color) => {
    const real = slots.map((s) => (s ? s.vals[k] : null));
    return {
      label, real, data: real.map((v) => (v === null ? null : Math.min(100, v))), borderColor: color, backgroundColor: color,
      borderWidth: 3, pointRadius: 6, pointHoverRadius: 8, tension: 0, spanGaps: true, clip: false, pointBorderColor: "#fff", pointBorderWidth: 2, labelBox: true, labelFont: "700 12px Figtree, sans-serif", valueFormat: (v, i) => `${+real[i].toFixed(1)}%`,
    };
  };
  // har week ke tasks ke neeche week + date
  const groupNames = {
    id: "groupNames",
    afterDraw(c) {
      const groups = TR_GROUPS[c.canvas.id] || [];
      const { ctx, scales: { x }, chartArea: a } = c;
      ctx.save();
      ctx.font = "700 15px Figtree, sans-serif"; ctx.fillStyle = "#1f4f9c"; ctx.textAlign = "center"; ctx.textBaseline = "top";
      for (const g of groups) {
        const x1 = x.getPixelForValue(g.from), x2 = x.getPixelForValue(g.to), mid = (x1 + x2) / 2;
        const maxW = Math.max(80, x2 - x1 + 40), words = g.name.split(/\s+/), out = [];
        for (const w of words) { const t = out.length ? `${out[out.length - 1]} ${w}` : w; if (out.length && ctx.measureText(t).width <= maxW) out[out.length - 1] = t; else out.push(w); }
        // week ke tasks ke neeche chhoti bracket line, us ke neeche week ka naam (kaunsa task kis week ka)
        const half = c.data.labels.length > 1 ? Math.abs(x.getPixelForValue(1) - x.getPixelForValue(0)) / 2 - 3 : 20;
        ctx.strokeStyle = "#9aa6b8"; ctx.lineWidth = 1.5; ctx.beginPath();
        ctx.moveTo(x1 - half, x.bottom + 2); ctx.lineTo(x1 - half, x.bottom + 7); ctx.lineTo(x2 + half, x.bottom + 7); ctx.lineTo(x2 + half, x.bottom + 2); ctx.stroke();
        out.forEach((t, k) => {
          const w = ctx.measureText(t).width + 20;
          ctx.save(); ctx.fillStyle = "#eef3fb"; ctx.strokeStyle = "#c9d6ea"; ctx.beginPath();
          ctx.roundRect ? ctx.roundRect(mid - w / 2, x.bottom + 10 + k * 26, w, 24, 12) : ctx.rect(mid - w / 2, x.bottom + 10 + k * 26, w, 24);
          ctx.fill(); ctx.stroke(); ctx.restore();
          ctx.fillText(t, mid, x.bottom + 14 + k * 26);
        });
      }
      ctx.restore();
    },
  };
  const nameRoom = 44;
  const width = `max(100%, ${slots.length * 44 + 140}px)`; // bahut weeks/tasks hon to side mein scroll
  document.querySelectorAll(".tr-chart").forEach((el) => { el.style.width = width; el.style.height = ""; });
  const chart = (id, title, datasets, ref = {}) => { TR_GROUPS[id] = groups; TR_REFS[id] = ref; drawChart(id, {
    type: "line",
    data: { labels, datasets },
    options: {
      layout: { padding: { top: 8, left: 6, right: 24, bottom: nameRoom } },
      interaction: { mode: "index", intersect: false },
      plugins: {
        title: { display: false },
        legend: { display: false }, // heading aur rang card ke upar HTML mein
        tooltip: { titleFont: { size: 14 }, bodyFont: { size: 14 }, padding: 10, filter: (it) => it.raw !== null, callbacks: {
          title: (items) => { const s = slots[items[0].dataIndex]; return s ? [s.g.name, `Week ${s.n} · ${s.label}`] : ""; },
          label: (ctx) => `${ctx.dataset.label}: ${+ctx.dataset.real[ctx.dataIndex].toFixed(1)}%`,
        } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { autoSkip: false, minRotation: 90, maxRotation: 90, padding: 4, color: "#1c2536", font: { size: 13, weight: "700" } } },
        y: { min: -8, max: 112, title: { display: true, text: "Percent (%)", color: "#1c2536", font: { size: 14, weight: "700" } },
          ticks: { stepSize: 10, autoSkip: false, callback: function (v) {
            if (v > 100 || v < 0) return "";
            const ref = TR_REFS[this.chart.canvas.id] || {};
            return v === 100 && ref.top ? [`${v}%`, ref.top] : v === 0 && ref.bottom ? [`${v}%`, ref.bottom] : `${v}%`;
          }, color: "#1c2536", font: { size: 13, weight: "700" } },
          afterBuildTicks: (ax) => { ax.ticks = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((value) => ({ value })); },
          grid: { color: (c) => (c.tick && (c.tick.value === 100 || c.tick.value === 0) ? "#c9d1dc" : "#eef1f5") } },
      },
    },
    plugins: [pointLabels, groupNames, stickyY],
  }); };
  const sub = `${who} · ${taskLabel}`;
  document.querySelectorAll(".tr-sub").forEach((el) => { el.textContent = sub; });
  chart("trChart1", `Planned vs Actual (${sub})`, [
    // Planned: moti hari line (neeche), % point ke upar hare rang mein
    { ...line("Planned", "plan", GREEN), order: 2, borderWidth: 8, borderColor: "rgba(47,158,79,.45)", backgroundColor: GREEN, labelColor: GREEN, pointRadius: 7, pointHoverRadius: 8 },
    // Actual: patli laal line (upar), % point ke neeche laal rang mein -> dono 100% hon to bhi dono dikhein
    { ...line("Actual", "act", RED), order: 1, borderWidth: 2.5, pointRadius: 4, labelBelow: true },
  ]);
  chart("trChart2", `Actual Delay (${sub})`, [line("Actual Delay", "aDl", ORANGE)]);
  chart("trChart3", `Commitment Not Done (${sub})`, [line("Commitment Not Done", "cNd", RED)]);
  chart("trChart4", `Commitment Delay (${sub})`, [line("Commitment Delay", "cDl", PURPLE)]);

  const empty = $("#trEmpty");
  empty.hidden = have.length > 0;
  empty.textContent = !idx.length ? "Koi week select nahi hai. Upar se week chuno." : `${who}${oneTask ? ` (${state.trTask})` : ""} ka in weeks mein koi data nahi hai.`;

  const v = $("#trVerdict");
  if (!have.length) { v.className = "pie-verdict"; v.textContent = ""; v.hidden = true; return; }
  v.hidden = false;
  const missing = pts.length - have.length;
  let msg = `${who}: ${fmt(tot.plan)} planned mein se ${fmt(tot.act)} actual done (${share(tot.act, tot.plan)}). ` +
    `Actual Delay ${fmt(tot.aDl)}, Commitment Not Done ${fmt(tot.cNd)}, Commitment Delay ${fmt(tot.cDl)}.`;
  if (missing) msg += ` ${missing} week mein entry nahi hai.`;
  v.className = `pie-verdict ${tot.act < tot.plan || tot.cNd ? "bad" : "good"}`;
  v.textContent = msg;
}

function initTrendEvents() {
  const redraw = () => { if (state.data) renderTrend(); };
  $("#trEmp").addEventListener("change", (e) => selectEmployee(e.target.value));
  $("#trTask").addEventListener("change", (e) => { state.trTask = e.target.value; redraw(); });
  const range = () => {
    const t = trendState();
    let a = +$("#trStart").value, b = +$("#trEnd").value;
    if (a > b) [a, b] = [b, a];
    t.start = a; t.end = b;
    redraw();
  };
  $("#trStart").addEventListener("change", range);
  $("#trEnd").addEventListener("change", range);
  $("#trWeeks").addEventListener("change", (e) => {
    const i = +e.target.value, t = trendState();
    if (e.target.checked) t.off.delete(i); else t.off.add(i);
    redraw();
  });
  $("#trAll").addEventListener("click", () => { trendState().off.clear(); redraw(); });
  $("#trNone").addEventListener("click", () => {
    const t = trendState();
    for (let i = t.start; i <= t.end; i++) t.off.add(i);
    redraw();
  });
}


// har patti ke upar uski value likho
const TR_GROUPS = {};
const TR_REFS = {}; // weekly graph: 0% / 100% line ka matlab
// side mein scroll karne par bhi left wala Y axis (0%-100%) wahin ruka rahe: axis wala hissa ek upar rakhe canvas mein copy
const stickyY = {
  id: "stickyY",
  afterRender(c) {
    const ov = document.querySelector(`canvas.tr-yaxis[data-for="${c.canvas.id}"]`);
    if (!ov || !c.chartArea) return;
    const r = c.currentDevicePixelRatio || 1, w = Math.ceil(c.chartArea.left), h = c.height;
    ov.width = w * r; ov.height = h * r; ov.style.width = `${w}px`; ov.style.height = `${h}px`;
    const x = ov.getContext("2d");
    x.fillStyle = "#fff"; x.fillRect(0, 0, ov.width, ov.height);
    x.drawImage(c.canvas, 0, 0, w * r, h * r, 0, 0, w * r, h * r);
  },
}; // weekly graph: canvas id -> us waqt ke task groups

const pointLabels = {
  id: "pointLabels",
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    ctx.save();
    ctx.font = "700 11px Figtree, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    chart.data.datasets.forEach((ds, di) => {
      const meta = chart.getDatasetMeta(di);
      if (meta.hidden) return;
      meta.data.forEach((pt, i) => {
        if (ds.data[i] === null || ds.data[i] === undefined) return;
        if (ds.hideLabel && ds.hideLabel(i)) return;
        ctx.fillStyle = ds.labelColor || ds.borderColor;
        ctx.font = ds.labelFont || "700 11px Figtree, sans-serif";
        const say = (txt, y, below) => {
          if (ds.labelBox) {
            const w = ctx.measureText(txt).width + 8, h = 16, top = below ? y - 1 : y - h + 1;
            ctx.save(); ctx.fillStyle = "rgba(255,255,255,.92)"; ctx.strokeStyle = ds.labelColor || ds.borderColor; ctx.lineWidth = 0.8;
            ctx.beginPath(); ctx.roundRect ? ctx.roundRect(pt.x - w / 2, top, w, h, 3) : ctx.rect(pt.x - w / 2, top, w, h); ctx.fill(); ctx.stroke(); ctx.restore();
          }
          ctx.textBaseline = below ? "top" : "bottom"; ctx.fillText(txt, pt.x, y); ctx.textBaseline = "bottom";
        };
        if (!ds.textLines && ds.labelBelow) { say((ds.valueFormat || fmt)(ds.data[i], i), pt.y + 9, true); return; }
        if (!ds.textLines) { say((ds.valueFormat || fmt)(ds.data[i], i), pt.y - 9, false); return; }
        // number ki jagah task ke naam, ek ke neeche ek (point ke upar, ya textBelow ho to neeche)
        const lines = ds.textLines(i);
        if (!lines.length) return;
        const LH = 13, n = meta.data.length;
        ctx.textAlign = n > 1 && i === 0 ? "left" : n > 1 && i === n - 1 ? "right" : "center";
        const x = ctx.textAlign === "left" ? pt.x - 4 : ctx.textAlign === "right" ? pt.x + 4 : pt.x;
        lines.forEach((t, k) => {
          const y = ds.textBelow ? pt.y + 10 + (k + 1) * LH : pt.y - 7 - (lines.length - 1 - k) * LH;
          ctx.fillText(t, x, y);
        });
        ctx.textAlign = "center";
      });
    });
    ctx.restore();
  },
};

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
    ...rows.map((r) => [...r.raw, ...idx.flatMap((i) => METRICS.map((m) => (r.weekly[i][m.k] === null ? "" : r.weeklyText[i][m.k])))].map(q).join(",")),
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
    row.weeklyText[wi][k] = s.value;
  }
}

/* =====================================================================
   5. LOAD + AUTO REFRESH
   ===================================================================== */

// har tab ka aakhri data (memory + browser mein), taaki tab badalte hi turant dikhe; naya data peeche se aata hai
const cacheKey = (sheet) => `mis_cache_${sheet}`;
function cachedSheet(sheet) {
  if (!state.cache[sheet]) {
    try { state.cache[sheet] = JSON.parse(store.get(cacheKey(sheet))) || undefined; } catch {}
  }
  return state.cache[sheet];
}
async function fetchSheet(sheet) {
  const res = await callScript({ action: "get", sheet });
  state.cache[sheet] = res;
  state.fresh.add(sheet);
  if (!store.set(cacheKey(sheet), JSON.stringify(res))) store.remove(cacheKey(sheet)); // jagah na ho to purana mat rakho
  return res;
}

// chuni hui sheet ka data dikhao (pehle jaisa hi ho to kuch nahi)
function showData(res, silent) {
  const sig = hash(JSON.stringify([res.values, res.notes]));
  const changed = state.signature && sig !== state.signature;
  if (sig === state.signature) return;
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

// state.loading = jis sheet ka load chal raha hai; doosri sheet chuni to uska load turant shuru (rukta nahi)
async function load({ silent = false } = {}) {
  const sheet = state.sheet;
  if (state.loading === sheet) return;
  if (silent && (state.saving || document.activeElement?.classList.contains("cell-in"))) return;
  state.loading = sheet;
  setSync("loading", silent ? "Checking sheet for changes…" : "Loading sheet… (5-10 sec)");
  try {
    const res = await fetchSheet(sheet);
    if (sheet !== state.sheet) return; // beech mein tab badal gaya: ye data bas cache mein rahega
    showData(res, silent);
    setSync("live", `Live · synced ${new Date().toLocaleTimeString("en-IN")} · every ${CONFIG.REFRESH_SECONDS}s`);
  } catch (err) {
    console.error(err);
    if (sheet !== state.sheet) return;
    setSync("error", "Sync failed");
    showError(err.message);
  } finally {
    if (state.loading === sheet) state.loading = false;
    if (sheet === state.sheet) {
      if (state.reloadAfter) { state.reloadAfter = false; load({ silent: true }); }
      prefetchSheets();
    }
  }
}

// baaki tabs ka data peeche se ek-ek karke laa ke rakho, taaki unhe chunte hi turant dikhe
async function prefetchSheets() {
  if (state.prefetching) return;
  state.prefetching = true;
  try {
    for (const o of $$("#sheetSelect option")) {
      const s = o.value;
      if (s === state.sheet || state.fresh.has(s)) continue;
      try { await fetchSheet(s); } catch (e) { console.warn("prefetch failed", s, e); }
    }
  } finally { state.prefetching = false; }
}

// tab badla: cache wala data turant, phir sheet se naya
function openSheetTab() {
  const c = cachedSheet(state.sheet);
  if (c) showData(c, false);
  load({ silent: !!c });
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
  state.sheetToEnd = true;
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
  if (v === "sheet") { freezeFixedCols(); syncHScroll(); if (state.data) renderSheetHist(); }
  Object.values(state.charts).forEach((c) => c.resize());
}

function bind() {
  $("#sheetSelect").value = state.sheet;
  $("#sheetSelect").addEventListener("change", (e) => {
    state.sheet = e.target.value;
    store.set("mis_sheet", state.sheet);
    state.signature = ""; state.selectedEmp = "__ALL__"; state.sheetToEnd = true;
    openSheetTab();
  });
  $("#weekRange").value = store.get("mis_weeks") || CONFIG.DEFAULT_WEEK_RANGE;
  $("#weekRange").addEventListener("change", (e) => {
    state.sheetToEnd = true;
    store.set("mis_weeks", e.target.value);
    renderSheetView();
    renderOverview();
    if (state.selectedEmp !== "__ALL__") renderEmployee();
  });
  $("#onlyFilledRows").addEventListener("change", renderEmployee);
  $("#hideEmpty").addEventListener("change", renderSheetView);
  initTrendEvents();
  $("#sheetSearch").addEventListener("input", renderSheetView);

  $("#year").textContent = new Date().getFullYear();
  $("#refreshBtn").addEventListener("click", () => { state.signature = ""; load(); });
  // employee search box
  const empInp = $("#empSearch"), empList = $("#empList");
  const openEmp = (filter) => {
    state.empFiltering = filter; state.empActive = 0;
    empList.hidden = false; empInp.setAttribute("aria-expanded", "true");
    renderEmpList();
  };
  const closeEmp = () => { empList.hidden = true; empInp.setAttribute("aria-expanded", "false"); empInp.value = empLabel(); };
  const pickEmp = (v) => { closeEmp(); empInp.blur(); if (v !== state.selectedEmp) selectEmployee(v); empInp.value = empLabel(); };
  empInp.addEventListener("focus", () => { empInp.value = ""; openEmp(false); }); // click karte hi khaali box: seedha naam type karo
  empInp.addEventListener("input", () => openEmp(true));
  empInp.addEventListener("blur", closeEmp);
  empInp.addEventListener("keydown", (e) => {
    if (empList.hidden && (e.key === "ArrowDown" || e.key === "Enter")) { e.preventDefault(); openEmp(false); return; }
    const n = (state.empItems || []).length;
    if (e.key === "ArrowDown") state.empActive = Math.min(n - 1, state.empActive + 1);
    else if (e.key === "ArrowUp") state.empActive = Math.max(0, state.empActive - 1);
    else if (e.key === "Enter") { e.preventDefault(); const o = state.empItems[state.empActive]; if (o) pickEmp(o.value); return; }
    else if (e.key === "Escape") { empInp.blur(); return; }
    else return;
    e.preventDefault();
    renderEmpList();
  });
  // mousedown par focus input se na hate, tabhi click se naam chuna jaaye
  empList.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const li = e.target.closest("li[data-v]");
    if (li) pickEmp(li.dataset.v);
  });
  $("#empToggle").addEventListener("mousedown", (e) => {
    e.preventDefault();
    if (empList.hidden) empInp.focus(); else empInp.blur();
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
  window.addEventListener("resize", () => { freezeFixedCols(); syncHScroll(); });
  // neeche ka scrollbar aur table ek saath chalein
  const wrap = $(".sheet-wrap"), hbar = $("#sheetHScroll");
  hbar.addEventListener("scroll", () => { if (wrap.scrollLeft !== hbar.scrollLeft) wrap.scrollLeft = hbar.scrollLeft; });
  wrap.addEventListener("scroll", () => { if (hbar.scrollLeft !== wrap.scrollLeft) hbar.scrollLeft = wrap.scrollLeft; });
  window.addEventListener("beforeunload", (e) => { if (state.edits.size) { e.preventDefault(); e.returnValue = ""; } });

  document.addEventListener("visibilitychange", () => { if (!document.hidden) load({ silent: true }); });
}

if (typeof module !== "undefined") module.exports = { parseGrid, parseDate };

if (typeof document !== "undefined") {
  bind();
  openSheetTab();
  startTimer();
}