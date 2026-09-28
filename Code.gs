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
    if (raw === "") t.cell.clearContent();
    else if (/%$/.test(raw)) t.cell.setValue(parseFloat(raw) / 100).setNumberFormat("0%");
    else t.cell.setValue(parseFloat(raw));
    return { ok: true, r: t.r, c: t.c, value: t.cell.getDisplayValue() };
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
