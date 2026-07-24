import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Usage: node generate-excel-perf.mjs <results.json> <outputBaseName.xlsx> [timestamp]
// A run timestamp is ALWAYS appended to the output filename so repeat runs never overwrite
// each other (same convention as generate-excel.mjs's withTimestamp()). Pass an explicit
// timestamp as the last arg for reproducible filenames; otherwise one is generated from the
// current time.
const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node generate-excel-perf.mjs <results.json> <outputBaseName.xlsx> [timestamp]');
  process.exit(1);
}
const outputPathArg = process.argv[3] || path.join(__dirname, 'reports', 'FlexForce_API_Performance_Report.xlsx');
const explicitTimestamp = process.argv[4] || null;

function withTimestamp(filePath, ts) {
  const stamp = ts || new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '').replace('T', '_');
  const ext = path.extname(filePath);
  const base = filePath.slice(0, -ext.length);
  return `${base}_${stamp}${ext}`;
}
const outputPath = withTimestamp(outputPathArg, explicitTimestamp);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });

const data = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));

function formatRunDate(filePath) {
  const stat = fs.statSync(filePath);
  return stat.mtime.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
const runDate = formatRunDate(inputPath);

// ── Thresholds — match by label substring, same pattern as generate-excel.mjs's classify(),
// extended with buckets for this suite's step labels. All four HTTP-verb "API: X" buckets
// share the same good/ok values since they're all single-request backend round-trips of
// similar shape (auth/register, license-mgt lookups/mutations) — NOT load/stress testing,
// just "how long did one real request take". ────────────────────────────────────────────
const API_THRESHOLD = { good: 500, ok: 1500 };
const THRESHOLDS = {
  'API: GET': API_THRESHOLD,
  'API: POST': API_THRESHOLD,
  'API: PUT': API_THRESHOLD,
  'API: DELETE': API_THRESHOLD,
  'Login': { good: 3000, ok: 6000 },
  'Page Load': { good: 2000, ok: 4000 },
  'Post-login': { good: 2000, ok: 4000 }, // "Post-login redirect/home render" — home UI paint after auth
};

function classify(label, ms) {
  const key = Object.keys(THRESHOLDS).find((k) => label.includes(k));
  if (!key) return { verdict: 'N/A', color: 'FFEEEEEE' };
  const t = THRESHOLDS[key];
  if (ms <= t.good) return { verdict: 'Good', color: 'FFC6EFCE', font: 'FF006100' };
  if (ms <= t.ok) return { verdict: 'Acceptable', color: 'FFFFEB9C', font: 'FF9C6500' };
  return { verdict: 'Slow', color: 'FFFFC7CE', font: 'FF9C0006' };
}

const COLORS = {
  headerBg: 'FF1F4E78',
  headerFont: 'FFFFFFFF',
  titleBg: 'FF203864',
  subHeaderBg: 'FFD9E1F2',
  na: 'FFF2F2F2',
};

// ── Styling helpers — copied in (not imported) from generate-excel.mjs so this file stays
// self-contained, per instructions. Keep in sync manually if the base styling changes. ────
function styleTitle(ws, rowNum, text, span) {
  ws.mergeCells(rowNum, 1, rowNum, span);
  const cell = ws.getCell(rowNum, 1);
  cell.value = text;
  cell.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.titleBg } };
  cell.alignment = { vertical: 'middle', horizontal: 'left' };
  ws.getRow(rowNum).height = 28;
}
function styleSubtitle(ws, rowNum, text, span) {
  ws.mergeCells(rowNum, 1, rowNum, span);
  const cell = ws.getCell(rowNum, 1);
  cell.value = text;
  cell.font = { italic: true, size: 10, color: { argb: 'FF555555' } };
}
function styleHeaderRow(row) {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: COLORS.headerFont } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerBg } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
  });
  row.height = 32;
}
function borderCell(cell) {
  cell.border = { top: { style: 'thin', color: { argb: 'FFD0D0D0' } }, bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } }, left: { style: 'thin', color: { argb: 'FFD0D0D0' } }, right: { style: 'thin', color: { argb: 'FFD0D0D0' } } };
}

const ROLE_ORDER = ['Root', 'Admin', 'Distributor', 'Partner', 'Client', 'BA'];
const orderedResults = ROLE_ORDER.map((role) => data.results.find((r) => r.role === role)).filter(Boolean);
// Any role present in the data but not in ROLE_ORDER (e.g. ad-hoc ROLE_FILTER runs against
// accounts like Distributor2/AdminOld/...) still needs to show up in the report.
const extraResults = data.results.filter((r) => !ROLE_ORDER.includes(r.role));
const results = [...orderedResults, ...extraResults];

function extraToString(extra) {
  if (extra == null) return '';
  if (typeof extra !== 'object') return String(extra);
  const parts = [];
  if (extra.status !== undefined) parts.push(`status=${extra.status}`);
  if (extra.method) parts.push(`method=${extra.method}`);
  if (extra.url) parts.push(`url=${extra.url}`);
  if (extra.userId !== undefined && extra.userId !== null) parts.push(`userId=${extra.userId}`);
  if (extra.skipped) parts.push(`skipped=true${extra.reason ? ` (${extra.reason})` : ''}`);
  if (extra.note) parts.push(`note=${extra.note}`);
  if (extra.body) parts.push(`body=${extra.body}`);
  return parts.join('  |  ');
}

const wb = new ExcelJS.Workbook();
wb.creator = 'FlexForce Performance Testing';
wb.created = new Date(Number(data.runTimestamp) || Date.now());

// ══════════════════════════════════════════════════════════════════════════
// SHEET 1: Summary
// ══════════════════════════════════════════════════════════════════════════
const sum = wb.addWorksheet('Summary', { views: [{ state: 'frozen', ySplit: 9 }] });
sum.columns = [
  { width: 16 }, { width: 30 }, { width: 14 }, { width: 16 }, { width: 12 }, { width: 12 }, { width: 40 },
];
styleTitle(sum, 1, 'FlexForce — Backend / API Performance-Timing Report', 7);
styleSubtitle(sum, 2, `Environment: ${data.baseUrl}   |   Module tested: License Management (API layer)   |   Run label: ${data.runLabel}`, 7);
styleSubtitle(sum, 3, `Run generated: ${runDate}   |   Run timestamp: ${data.runTimestamp}`, 7);
sum.getRow(4).height = 6;

sum.getCell(5, 1).value = 'What this report shows';
sum.getCell(5, 1).font = { bold: true, size: 12 };
sum.mergeCells(5, 1, 5, 7);
sum.getCell(6, 1).value =
  'This measures real, single-request backend/API response times (Login endpoint, register, and License Management '
  + 'add/update/delete endpoints) against the live application, per user role. This is a TIMING suite, NOT a load or '
  + 'stress test — each endpoint is called once per role, sequentially, not under concurrent/repeated load. Known live '
  + 'defects/limitations are recorded as data (status code + note) rather than treated as script failures — see the '
  + 'Details tab and each role\'s Notes for specifics (e.g. confirmed 404/405 responses).';
sum.mergeCells(6, 1, 6, 7);
sum.getCell(6, 1).alignment = { wrapText: true, vertical: 'top' };
sum.getRow(6).height = 58;

let r = 8;
sum.getCell(r, 1).value = 'Per-Role Summary';
sum.getCell(r, 1).font = { bold: true, size: 12 };
sum.mergeCells(r, 1, r, 7);
r++;
sum.getCell(r, 1).value = '"API Avg" = average response time across only the "API: ..." steps (register + license-mgt lookup/add/update/delete), excluding the browser-driven Login/Page-Load steps. "Failures" counts any step where the script itself failed (exception/timeout) — a recorded 404/405 status is NOT counted as a failure when it is documented as an expected/known finding.';
sum.mergeCells(r, 1, r, 7);
sum.getCell(r, 1).font = { italic: true, size: 9, color: { argb: 'FF666666' } };
sum.getCell(r, 1).alignment = { wrapText: true };
sum.getRow(r).height = 30;
r++;

const summaryHeaderRow = sum.getRow(r);
['Role', 'Username', 'Steps Measured', 'API Avg Response', 'Failures', 'Login (API) ms', 'Fatal Error'].forEach((h, i) => summaryHeaderRow.getCell(i + 1).value = h);
styleHeaderRow(summaryHeaderRow);
r++;

for (const res of results) {
  const row = sum.getRow(r);
  const apiSteps = (res.flow || []).filter((s) => s.label.startsWith('API:'));
  const failures = (res.flow || []).filter((s) => s.ok === false);
  const loginStep = (res.flow || []).find((s) => s.label === 'Login (API response)');
  const fatal = (res.notes || []).find((n) => n.startsWith('Fatal error'));

  row.getCell(1).value = res.role;
  row.getCell(1).font = { bold: true };
  row.getCell(2).value = res.username;
  row.getCell(3).value = (res.flow || []).length;
  row.getCell(3).alignment = { horizontal: 'center' };

  const avgCell = row.getCell(4);
  if (apiSteps.length) {
    const avgMs = apiSteps.reduce((a, s) => a + s.ms, 0) / apiSteps.length;
    const cls = classify('API: ', avgMs); // shared API_THRESHOLD regardless of verb
    avgCell.value = `${Math.round(avgMs)}ms (${cls.verdict})`;
    avgCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: cls.color } };
    avgCell.font = { color: { argb: cls.font || 'FF000000' }, bold: true };
  } else {
    avgCell.value = 'N/A';
    avgCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.na } };
    avgCell.font = { color: { argb: 'FF999999' }, italic: true };
  }
  avgCell.alignment = { horizontal: 'center' };

  const failCell = row.getCell(5);
  failCell.value = failures.length;
  failCell.alignment = { horizontal: 'center' };
  if (failures.length > 0) {
    failCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
    failCell.font = { color: { argb: 'FF9C0006' }, bold: true };
  } else {
    failCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' } };
    failCell.font = { color: { argb: 'FF006100' } };
  }

  const loginCell = row.getCell(6);
  if (loginStep && loginStep.ok) {
    loginCell.value = loginStep.ms;
    const cls = classify('Login', loginStep.ms);
    loginCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: cls.color } };
    loginCell.font = { color: { argb: cls.font || 'FF000000' } };
  } else {
    loginCell.value = 'N/A';
    loginCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.na } };
    loginCell.font = { color: { argb: 'FF999999' }, italic: true };
  }
  loginCell.alignment = { horizontal: 'center' };

  row.getCell(7).value = fatal || '';
  row.getCell(7).font = { italic: true, size: 9, color: { argb: 'FF9C0006' } };
  row.getCell(7).alignment = { wrapText: true };

  row.eachCell(borderCell);
  r++;
}
r += 1;

sum.getCell(r, 1).value = 'Thresholds used for Good / Acceptable / Slow';
sum.getCell(r, 1).font = { bold: true, size: 11 };
sum.mergeCells(r, 1, r, 7);
r++;
const legendHeader = sum.getRow(r);
['Bucket (matched by label substring)', 'Good (<=)', 'Acceptable (<=)', 'Slow (>)'].forEach((h, i) => legendHeader.getCell(i + 1).value = h);
styleHeaderRow(legendHeader);
r++;
const seenBuckets = new Set();
for (const [key, t] of Object.entries(THRESHOLDS)) {
  const bucketId = `${t.good}-${t.ok}`;
  const label = key === 'API: GET' || key === 'API: POST' || key === 'API: PUT' || key === 'API: DELETE'
    ? (seenBuckets.has('api') ? null : (seenBuckets.add('api'), 'API: GET / POST / PUT / DELETE'))
    : key;
  if (label === null) continue;
  const row = sum.getRow(r);
  row.getCell(1).value = label;
  row.getCell(2).value = `${t.good}ms`;
  row.getCell(3).value = `${t.ok}ms`;
  row.getCell(4).value = `>${t.ok}ms`;
  row.eachCell(borderCell);
  r++;
}

// ══════════════════════════════════════════════════════════════════════════
// SHEET 2: Details — every step, every role
// ══════════════════════════════════════════════════════════════════════════
const det = wb.addWorksheet('Details');
det.columns = [{ width: 4 }, { width: 46 }, { width: 10 }, { width: 12 }, { width: 8 }, { width: 34 }, { width: 60 }];
styleTitle(det, 1, 'Details — Every Step, Every Role', 7);
styleSubtitle(det, 2, 'Time is the measured single-request/step duration in ms. "OK" = the script itself succeeded (no exception/timeout) — a documented 404/405 defect status can still be OK=true; see Notes.', 7);
let dr = 4;
for (const res of results) {
  det.getCell(dr, 1).value = `${res.role}  (${res.username})`;
  det.mergeCells(dr, 1, dr, 7);
  det.getCell(dr, 1).font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
  det.getCell(dr, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerBg } };
  dr++;
  const hdr = det.getRow(dr);
  ['#', 'Step', 'Time (ms)', 'Verdict', 'OK', 'Extra (status/url/etc.)', 'Error'].forEach((h, i) => hdr.getCell(i + 1).value = h);
  styleHeaderRow(hdr);
  dr++;
  (res.flow || []).forEach((s, i) => {
    const row = det.getRow(dr);
    row.getCell(1).value = i + 1;
    row.getCell(2).value = s.label;
    row.getCell(3).value = s.ms;
    row.getCell(3).alignment = { horizontal: 'center' };

    const cls = classify(s.label, s.ms);
    const verdictCell = row.getCell(4);
    if (s.ok === false) {
      verdictCell.value = 'FAILED';
      verdictCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
      verdictCell.font = { color: { argb: 'FF9C0006' }, bold: true };
      row.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
    } else {
      verdictCell.value = cls.verdict;
      verdictCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: cls.color } };
      verdictCell.font = { color: { argb: cls.font || 'FF000000' } };
      row.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: cls.color } };
      row.getCell(3).font = { color: { argb: cls.font || 'FF000000' } };
    }
    verdictCell.alignment = { horizontal: 'center' };

    row.getCell(5).value = s.ok === false ? 'No' : 'Yes';
    row.getCell(5).alignment = { horizontal: 'center' };

    row.getCell(6).value = extraToString(s.extra);
    row.getCell(6).font = { size: 9 };
    row.getCell(6).alignment = { wrapText: true };

    row.getCell(7).value = s.error || '';
    row.getCell(7).font = { size: 9, color: { argb: 'FF9C0006' } };
    row.getCell(7).alignment = { wrapText: true };

    row.eachCell(borderCell);
    dr++;
  });

  if ((res.notes || []).length) {
    det.getCell(dr, 1).value = 'Notes:';
    det.getCell(dr, 1).font = { italic: true, bold: true };
    dr++;
    res.notes.forEach((n) => {
      det.getCell(dr, 2).value = `• ${n}`;
      det.mergeCells(dr, 2, dr, 7);
      det.getCell(dr, 2).alignment = { wrapText: true };
      det.getCell(dr, 2).font = { italic: true, size: 9, color: { argb: 'FF666666' } };
      dr++;
    });
  }
  dr += 1;
}

await wb.xlsx.writeFile(outputPath);
console.log(`Saved report to ${outputPath}`);
