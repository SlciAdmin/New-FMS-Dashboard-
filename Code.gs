/**
 * MIS Dashboard – data pipe (read + comments + values)
 * UI aapke VS Code wale HTML/CSS/JS mein hai. Ye sirf data deta hai, comments aur values likhta hai.
 * Comments = Google Sheet ke "Notes" (cell par right-click → Insert note / Shift+F2).
 * Values = weekly Score / Commitment cells mein seedha number likhta hai.
 * UI se likha sheet mein dikhega, sheet mein likha UI mein dikhega.
 *
 * Isko badalne ke baad: Deploy → Manage deployments → Edit (pencil) → Version: "New version" → Deploy.
 * (URL wahi rehta hai, script.js badalna nahi padta.)
 */

const SPREADSHEET_ID = "1H9x05m0LhZGiNaU1iGR3vBVDBMDe21D6FCelyL7QmpA";
const SECRET_KEY = "ndr-mis-8472-xyz"; // script.js ke SCRIPT_KEY jaisa hi hona chahiye
const TIMEZONE = "Asia/Kolkata";

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.key !== SECRET_KEY) return send({ error: "Unauthorized: key galat hai" }, p.callback);
  try {
    if (p.action === "note") return send(saveNote(p), p.callback);
    if (p.action === "values") return send(saveValues(p), p.callback);
    if (p.action === "value") return send(saveValue(p), p.callback);
    return send(getData(p), p.callback);
  } catch (err) {
    return send({ error: friendlyError(err) }, p.callback);
  }
}

function openSheet(name) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sh = ss.getSheetByName(name || "MIS-2025");
  if (!sh) {
    const e = new Error('Tab nahi mila: "' + name + '". Tabs: ' + ss.getSheets().map(function (s) { return s.getName(); }).join(", "));
    throw e;
  }
  return sh;
}

/* ---------------- READ ---------------- */
function getData(p) {
  const sh = openSheet(p.sheet);
  const range = sh.getDataRange();
  const values = range.getDisplayValues();
  addLinkUrls(sh, values);

  // notes: sirf jin cells mein note hai [row, col, text] (0-based)
  const notes = [];
  const n = range.getNotes();
  for (let r = 0; r < n.length; r++) {
    for (let c = 0; c < n[r].length; c++) {
      if (n[r][c]) notes.push([r, c, n[r][c]]);
    }
  }

  const trimmed = values.map(function (r) {
    let end = r.length;
    while (end > 0 && r[end - 1] === "") end--;
    return r.slice(0, end);
  });
  while (trimmed.length && trimmed[trimmed.length - 1].length === 0) trimmed.pop();

  const meta = getLayoutInfo(sh, values);
  return {
    sheet: sh.getName(), updated: new Date().toISOString(), values: trimmed, notes: notes,
    hiddenCols: meta.hiddenCols, teamMerges: meta.teamMerges,
  };
}

// Team column ke merged naam-khaane (kis naam ke neeche kaun si rows) + hidden columns
function getLayoutInfo(sh, values) {
  const out = { hiddenCols: [], teamMerges: [] };
  const h = values.findIndex(function (r, i) { return i < 8 && r.some(function (c) { return /result\s*in\s*area/i.test(c); }); });
  if (h === -1) return out;
  let tc = values[h].findIndex(function (c) { return /^team$/i.test(String(c).trim()); });
  const ac = values[h].findIndex(function (c) { return /result\s*in\s*area/i.test(c); });
  if (tc === -1) tc = Math.max(0, ac - 1);

  const maxC = Math.min(sh.getMaxColumns(), 40);
  for (let c = 1; c <= maxC; c++) {
    if (sh.isColumnHiddenByUser(c)) out.hiddenCols.push(c - 1);
  }
  const n = values.length - h - 1;
  if (n > 0) {
    sh.getRange(h + 2, tc + 1, n, 1).getMergedRanges().forEach(function (m) {
      out.teamMerges.push([m.getRow() - 1, m.getLastRow() - 1]);
    });
  }
  return out;
}

/* ---------------- WRITE HELPERS ---------------- */
// row/col/areaCol naye naam hain (r + c saath bhejne par Google 400 error deta tha); r/c/ac purane client ke liye
function targetCell(sh, p) {
  const r = parseInt(p.row !== undefined ? p.row : p.r, 10), c = parseInt(p.col !== undefined ? p.col : p.c, 10);
  if (!(r >= 0 && c >= 0)) throw new Error("Galat cell");
  const ac = p.areaCol !== undefined ? p.areaCol : p.ac;

  // safety: row abhi bhi wahi task area hai na?
  if (p.area && ac !== undefined) {
    const now = String(sh.getRange(r + 1, parseInt(ac, 10) + 1).getDisplayValue()).trim();
    if (now !== String(p.area).trim()) {
      throw new Error("Sheet mein rows badal gayi hain (yahan ab \"" + now + "\" hai). Refresh karke dobara likho.");
    }
  }
  return { r: r, c: c, cell: sh.getRange(r + 1, c + 1) };
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ---------------- WRITE COMMENT ---------------- */
// params: sheet, r, c (0-based), ac (area column), area (expected text), mode = append|replace, text, name
function saveNote(p) {
  const sh = openSheet(p.sheet);
  const t = targetCell(sh, p);
  return withLock(function () {
    let text = String(p.text || "").trim();
    if (p.mode === "append" && text) {
      const stamp = Utilities.formatDate(new Date(), TIMEZONE, "dd MMM yyyy, hh:mm a");
      const who = String(p.name || "").trim();
      const line = "[" + stamp + (who ? " · " + who : "") + "] " + text;
      const old = t.cell.getNote();
      text = old ? old + "\n" + line : line;
    }
    t.cell.setNote(text); // khaali text = note delete
    return { ok: true, r: t.r, c: t.c, note: text };
  });
}

/* ---------------- WRITE VALUE ---------------- */
// params: sheet, r, c (0-based), ac, area, value ("" = cell khaali)
function saveValue(p) {
  const sh = openSheet(p.sheet);
  const t = targetCell(sh, p);
  const raw = String(p.value === undefined ? "" : p.value).trim();
  if (raw !== "" && !/^-?\d+(\.\d+)?%?$/.test(raw)) throw new Error("Value sirf number honi chahiye (jaise 0, 5, -18).");

  return withLock(function () {
    // formula wale cell ko overwrite nahi karna (warna formula hat jaayega)
    if (t.cell.getFormula()) {
      throw new Error("Is cell mein formula hai (" + t.cell.getFormula() + "). Iski value sheet khud nikaalti hai, yahan se nahi badal sakte.");
    }
    writeNumber(t.cell, raw);
    return { ok: true, r: t.r, c: t.c, value: raw };
  });
}

// value likho, wapas padho nahi (padhne par Google pehle poori sheet recalculate karta hai = 1-3 sec extra)
function writeNumber(cell, raw) {
  if (raw === "") cell.clearContent();
  else if (/%$/.test(raw)) cell.setValue(parseFloat(raw) / 100).setNumberFormat("0%");
  else cell.setValue(parseFloat(raw));
}

/* ---------------- WRITE MANY VALUES (ek request, ek lock) ---------------- */
// params: sheet, areaCol, items = JSON [{ row, col, area, value }, ...] (0-based)
// har item ka alag result { ok, value } ya { error }: ek galat cell baaki cells ko nahi rokta
function saveValues(p) {
  const sh = openSheet(p.sheet);
  const items = JSON.parse(p.items || "[]");
  if (!items.length) return { ok: true, results: [] };
  const ac = parseInt(p.areaCol, 10);

  return withLock(function () {
    // pehle saari reads ek saath, phir saari writes (beech mein read karne se Google har baar flush karta hai)
    const rows = items.map(function (it) { return parseInt(it.row, 10); });
    const cols = items.map(function (it) { return parseInt(it.col, 10); });
    if (rows.concat(cols).some(function (n) { return !(n >= 0); })) throw new Error("Galat cell");
    const r0 = Math.min.apply(null, rows), r1 = Math.max.apply(null, rows);
    const c0 = Math.min.apply(null, cols), c1 = Math.max.apply(null, cols);
    const formulas = sh.getRange(r0 + 1, c0 + 1, r1 - r0 + 1, c1 - c0 + 1).getFormulas();
    const areas = ac >= 0 ? sh.getRange(r0 + 1, ac + 1, r1 - r0 + 1, 1).getDisplayValues() : null;

    const results = items.map(function (it, i) {
      const r = rows[i], c = cols[i];
      const raw = String(it.value === undefined || it.value === null ? "" : it.value).trim();
      if (raw !== "" && !/^-?\d+(\.\d+)?%?$/.test(raw)) return { error: "Value sirf number honi chahiye (jaise 0, 5, -18)." };
      if (areas && it.area) {
        const now = String(areas[r - r0][0]).trim();
        if (now !== String(it.area).trim()) {
          return { error: "Sheet mein rows badal gayi hain (yahan ab \"" + now + "\" hai). Refresh karke dobara likho." };
        }
      }
      const f = formulas[r - r0][c - c0];
      if (f) return { error: "Is cell mein formula hai (" + f + "). Iski value sheet khud nikaalti hai, yahan se nahi badal sakte." };
      try {
        writeNumber(sh.getRange(r + 1, c + 1), raw);
        return { ok: true, value: raw };
      } catch (err) {
        return { error: friendlyError(err) };
      }
    });
    return { ok: true, results: results };
  });
}

function friendlyError(err) {
  const s = String(err && err.message || err);
  if (/permission|access|not have|edit/i.test(s) && !/formula/i.test(s)) {
    return "Sheet mein save nahi hua: jis account se script deploy hua hai uske paas sheet ka EDIT access nahi hai (abhi View only hai). " +
      "Sheet ke owner (shakti@sksharma.in) se Editor access lo, phir dobara try karo.";
  }
  return s;
}

/* ---------------- LINKS ---------------- */
function addLinkUrls(sh, values) {
  const h = values.findIndex(function (r, i) { return i < 8 && r.some(function (c) { return /result\s*in\s*area/i.test(c); }); });
  if (h === -1) return;
  const lc = values[h].findIndex(function (c) { return /^link$/i.test(String(c).trim()); });
  if (lc === -1 || values.length <= h + 1) return;
  const n = values.length - h - 1;
  const range = sh.getRange(h + 2, lc + 1, n, 1);
  let rich = [], formulas = [];
  try { rich = range.getRichTextValues(); } catch (e) {}
  try { formulas = range.getFormulas(); } catch (e) {}
  for (let i = 0; i < n; i++) {
    let url = rich[i] && rich[i][0] && rich[i][0].getLinkUrl();
    if (!url && formulas[i] && formulas[i][0]) {
      const m = formulas[i][0].match(/HYPERLINK\(\s*"([^"]+)"/i);
      if (m) url = m[1];
    }
    if (url) values[h + 1 + i][lc] = url;
  }
}

function send(obj, callback) {
  const json = JSON.stringify(obj);
  if (callback && /^[\w$.]+$/.test(callback)) {
    return ContentService.createTextOutput(callback + "(" + json + ")").setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- AUTO-FILL: Not Done / Delay% → aaj ki date wale week column ka Score (Actual) ---------------- */
// Roz subah 8-9 baje script aaj ki date dekhta hai. Sheet mein bilkul aaj ki date ka week column hai
// (jaise Monday 2 Nov ko "2 November 2026") to har row ka current "Not Done" → Score · Not done,
// "Delay%" → Score · Delay mein bhar deta hai (jaise UAN: -7% aur -68%). Aaj ki date ka column nahi to kuch nahi bharta.
// Ek baar editor se setupDailyTrigger() Run karo, phir apne aap chalega.
const AUTO_SHEETS = ["MIS-2025", "MIS-HOD-2025"];

function fillWeeklyActual() {
  AUTO_SHEETS.forEach(function (name) {
    try { Logger.log(name + ": " + JSON.stringify(fillActualFor(name))); }
    catch (err) { Logger.log(name + ": " + friendlyError(err)); }
  });
}

function setupDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "fillWeeklyActual") ScriptApp.deleteTrigger(t); // purana Monday wala bhi hat jaata hai
  });
  ScriptApp.newTrigger("fillWeeklyActual").timeBased().everyDays(1).atHour(8).inTimezone(TIMEZONE).create();
  Logger.log("Roz 8-9 baje (" + TIMEZONE + ") fillWeeklyActual chalega; jis din aaj ki date ka column hoga usi din bharega.");
}

// EK BAAR chalao: 27 Oct ko purane code ne galti se "19 October 2026" mein jo Actual bhara tha use hatao.
// Sirf wahi cells saaf hote hain jinki value abhi ke Not Done / Delay% jaisi hai (yaani jo script ne bhari thi).
function clearWrongActual() {
  AUTO_SHEETS.forEach(function (name) {
    try {
      const L = actualLayout(name);
      const w = L.weeks.filter(function (x) { return x.label === "19 October 2026"; })[0];
      Logger.log(name + ": " + (w ? "19 October 2026 se " + clearAutoActual(L, w) + " cells hataye" : "19 October 2026 ka column nahi mila"));
    } catch (err) { Logger.log(name + ": " + friendlyError(err)); }
  });
}

// sheet ka dhaancha: header row, Result in area, Not Done / Delay% columns, week columns (script.js jaisa)
function actualLayout(name) {
  const sh = openSheet(name);
  const values = sh.getDataRange().getDisplayValues();
  const h = values.findIndex(function (r, i) { return i < 8 && r.some(function (c) { return /result\s*in\s*area/i.test(c); }); });
  if (h < 2) throw new Error("Result in area wala header nahi mila");
  const head = values[h].map(function (c) { return String(c).trim(); }), weekRow = values[h - 2];
  const ac = head.findIndex(function (c) { return /result\s*in\s*area/i.test(c); });

  let firstWeek = -1;
  for (let c = ac + 3; c < head.length; c++) {
    if (String(weekRow[c]).trim() && /not\s*done/i.test(head[c])) { firstWeek = c; break; }
  }
  if (firstWeek === -1) throw new Error("Week columns nahi mile");
  const ndCol = head.findIndex(function (c, i) { return i > ac && i < firstWeek && /^not\s*done$/i.test(c); });
  const dlCol = head.findIndex(function (c, i) { return i > ac && i < firstWeek && /delay\s*%/i.test(c); });
  if (ndCol === -1 || dlCol === -1) throw new Error("Not Done / Delay% column nahi mila");

  const weeks = [];
  for (let c = firstWeek; c < head.length; c += 4) {
    const d = parseSheetDate(weekRow[c]);
    if (d) weeks.push({ c: c, date: d, label: String(weekRow[c]).trim() });
  }
  const n = values.length - h - 1;
  const src = n > 0 ? sh.getRange(h + 2, 1, n, Math.max(ndCol, dlCol) + 1).getValues() : [];
  return { sh: sh, values: values, h: h, ac: ac, ndCol: ndCol, dlCol: dlCol, weeks: weeks, n: n, src: src };
}

// aaj ki date wala week column (bilkul aaj ki date); na ho to null
function todayWeek(L) {
  const today = Utilities.formatDate(new Date(), TIMEZONE, "yyyy-M-d"); // India ka aaj, project timezone kuch bhi ho
  return L.weeks.filter(function (w) {
    return w.date.getFullYear() + "-" + (w.date.getMonth() + 1) + "-" + w.date.getDate() === today;
  })[0] || null;
}

// overwrite = false: jis Score cell mein pehle se value hai use nahi chhedta
function fillActualFor(name, overwrite) {
  const L = actualLayout(name), w = todayWeek(L);
  if (!w) return { week: null, filled: 0, note: "Aaj (" + Utilities.formatDate(new Date(), TIMEZONE, "d MMMM yyyy") + ") ki date ka column nahi hai, kuch nahi bhara" };
  if (L.n <= 0) return { week: w.label, filled: 0 };
  const target = L.sh.getRange(L.h + 2, w.c + 1, L.n, 2);

  return withLock(function () {
    const cur = target.getValues(), formulas = target.getFormulas(), formats = target.getNumberFormats();
    let filled = 0;
    for (let i = 0; i < L.n; i++) {
      if (!String(L.values[L.h + 1 + i][L.ac]).trim()) continue; // task area wali rows hi
      [L.ndCol, L.dlCol].forEach(function (from, j) {
        const v = L.src[i][from];
        if (typeof v !== "number" || formulas[i][j]) return;
        if (!overwrite && cur[i][j] !== "") return;
        cur[i][j] = v; formats[i][j] = "0%"; filled++;
      });
    }
    if (filled) { target.setValues(cur); target.setNumberFormats(formats); }
    return { week: w.label, filled: filled };
  });
}

// us week ke Score cells mein se wahi khaali karo jo abhi ke Not Done / Delay% se milte hain
function clearAutoActual(L, w) {
  if (L.n <= 0) return 0;
  const target = L.sh.getRange(L.h + 2, w.c + 1, L.n, 2);
  return withLock(function () {
    const cur = target.getValues(), formulas = target.getFormulas();
    let cleared = 0;
    for (let i = 0; i < L.n; i++) {
      [L.ndCol, L.dlCol].forEach(function (from, j) {
        const v = L.src[i][from];
        if (formulas[i][j] || cur[i][j] === "" || typeof v !== "number" || cur[i][j] !== v) return;
        cur[i][j] = ""; cleared++;
      });
    }
    if (cleared) target.setValues(cur);
    return cleared;
  });
}

// "19 October 2026" / "4 Jan 2025" → Date
function parseSheetDate(s) {
  const m = String(s).trim().match(/^(\d{1,2})[\s-]+([A-Za-z]+)[\s,-]+(\d{2,4})$/);
  if (!m) return null;
  const mi = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].indexOf(m[2].slice(0, 3).toLowerCase());
  return mi < 0 ? null : new Date(+(m[3].length === 2 ? "20" + m[3] : m[3]), mi, +m[1]);
}

/* ---------------- TESTS (editor se Run karo) ---------------- */
function testRun() {
  const out = getData({ sheet: "MIS-2025" });
  Logger.log("Rows: " + out.values.length + ", notes: " + out.notes.length);
  Logger.log(JSON.stringify(out.notes.slice(0, 5)));
}
// Edit access check: MIS-2025 ke B4 (PAYROLL) par test note likhta aur hata deta hai
function testWrite() {
  const sh = openSheet("MIS-2025");
  const cell = sh.getRange("B4");
  const old = cell.getNote();
  cell.setNote("test");
  cell.setNote(old);
  Logger.log("Edit access theek hai, comments aur values save honge.");
}
