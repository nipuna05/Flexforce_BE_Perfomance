import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Appends one run's timing data to the persistent cross-release trend log
// (results/ba-grid-perf-trend.json), flattening each role's step list into a
// flat array so compare-perf-runs.mjs can diff any two runs label-by-label
// without caring how many roles or steps either run had.
//
// Ported from v1_perfomance's record-perf-run.mjs (same structure, same
// TREND_FILE override convention) so BA Grid runs compare the same way FE
// perf runs do.
//
// Usage:
//   node record-perf-run.mjs <combinedResultsFile> <runStamp> <date> <releaseJsonFile>

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = path.join(__dirname, 'results');
const trendPath = path.join(resultsDir, process.env.TREND_FILE || 'ba-grid-perf-trend.json');

const [, , combinedResultsFile, runStamp, date, releaseJsonFile] = process.argv;

if (!combinedResultsFile || !runStamp || !date || !releaseJsonFile) {
  console.error('Usage: node record-perf-run.mjs <combinedResultsFile> <runStamp> <date> <releaseJsonFile>');
  process.exit(1);
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

const combined = loadJson(path.isAbsolute(combinedResultsFile) ? combinedResultsFile : path.join(resultsDir, combinedResultsFile));
const release = loadJson(releaseJsonFile);

const steps = [];
for (const roleResult of combined.results) {
  for (const step of roleResult.flow || []) {
    steps.push({
      role: roleResult.role,
      label: step.label,
      ms: step.ms,
      ok: step.ok,
    });
  }
}

const trend = fs.existsSync(trendPath) ? loadJson(trendPath) : { runs: [] };

if (trend.runs.some(r => r.runStamp === runStamp)) {
  console.error(`Run ${runStamp} is already recorded in the trend log - refusing to add a duplicate. Delete the existing entry first if this is intentional.`);
  process.exit(1);
}

trend.runs.push({
  runStamp,
  date,
  baseUrl: combined.baseUrl,
  combinedResultsFile: path.basename(combinedResultsFile),
  release,
  steps,
});

fs.writeFileSync(trendPath, JSON.stringify(trend, null, 2));
console.log(`Recorded run ${runStamp} (${date}) - ${steps.length} steps across ${combined.results.length} roles.`);
console.log(`Trend log now has ${trend.runs.length} run(s): ${trend.runs.map(r => r.runStamp).join(', ')}`);
