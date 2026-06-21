// Merge unit/integration/ui test-results into validation_report.json + .md (test counts + readiness).
import fs from 'node:fs';
import path from 'node:path';
import { OUT_DIR } from './config.mjs';

const VAL = path.join(OUT_DIR, 'validation');
const TR = path.join(OUT_DIR, 'test-results');
const reportPath = path.join(VAL, 'validation_report.json');

function readJson(f) {
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

const report = readJson(reportPath);
if (!report) {
  console.error('validation_report.json not found — run run-sprint.mjs first');
  process.exit(1);
}
const unit = readJson(path.join(TR, 'unit-test-results.json'));
const integ = readJson(path.join(TR, 'integration-test-results.json'));
const ui = readJson(path.join(TR, 'ui-test-results.json'));

const counts = (s) => (s ? { passed: s.passed, failed: s.failed } : null);
report.tests = { unit: counts(unit), integration: counts(integ), ui: counts(ui) };
const totalFailed = [unit, integ, ui].filter(Boolean).reduce((n, s) => n + s.failed, 0);
report.tests.total_failed = totalFailed;
report.finalized_at = new Date().toISOString();

fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

// append test summary to the markdown report
const mdPath = path.join(VAL, 'validation_report.md');
let md = fs.readFileSync(mdPath, 'utf8');
const block = [
  '',
  '## Test results (finalized)',
  '',
  `- Run timestamp: ${report.finalized_at}`,
  `- Unit: ${unit ? `${unit.passed} passed / ${unit.failed} failed` : 'n/a'}`,
  `- Integration: ${integ ? `${integ.passed} passed / ${integ.failed} failed` : 'n/a'}`,
  `- UI: ${ui ? `${ui.passed} passed / ${ui.failed} failed` : 'n/a'}`,
  `- Total failed: ${totalFailed}`,
  `- Screenshots: test-results/screenshots/validation-console-desktop.png, validation-console-mobile.png`,
  `- Sprint readiness: **${report.readiness}**`,
  '',
].join('\n');
md = md.replace(/## Test results[\s\S]*$/m, block.trimStart());
if (!/## Test results \(finalized\)/.test(md)) md += '\n' + block;
fs.writeFileSync(mdPath, md);

console.log(`Finalized: unit ${unit?.passed}/${unit?.failed} · integration ${integ?.passed}/${integ?.failed} · ui ${ui?.passed}/${ui?.failed} · readiness ${report.readiness}`);
