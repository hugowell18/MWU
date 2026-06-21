// UI tests: assert the built console + served report satisfy the status rules, and that screenshots exist.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUT_DIR, ROOT } from '../../scripts/validation-sprint/config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(OUT_DIR, 'test-results', 'screenshots');
const BUILD = path.join(ROOT, 'build-validation');

const cases = [];
async function t(name, fn) {
  try {
    await fn();
    cases.push({ name, status: 'passed' });
    console.log(`  ✅ ${name}`);
  } catch (e) {
    cases.push({ name, status: 'failed', detail: e.message });
    console.log(`  ❌ ${name} — ${e.message}`);
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m);
};

async function main() {
  console.log('UI TESTS');
  const port = process.env.VC_PORT || 4173;
  const base = `http://localhost:${port}`;

  let report = null;
  await t('Console HTML served with mount node', async () => {
    const html = await (await fetch(`${base}/`)).text();
    assert(/id="root"/.test(html), 'no #root');
    assert(/MWU . Validation Console|MWU/.test(html), 'wrong title');
  });

  await t('API serves a real report (gold passed, 0.35 no-gold, Phase I skipped)', async () => {
    report = await (await fetch(`${base}/api/report`)).json();
    assert(report.phase_i.status === 'skipped', 'phase I not skipped');
    assert(report.phase_ii.gold_replay.status === 'passed', 'gold not passed');
    const t035 = report.phase_ii.thresholds.find((x) => Number(x.threshold) === 0.35);
    assert(t035 && (t035.kind === 'generated_no_gold' || t035.status === 'generated_no_gold'), '0.35 not no-gold');
  });

  await t('Built bundle renders required panels (checklist/config/stepper/table/artifacts)', async () => {
    const js = fs.readdirSync(path.join(BUILD, 'assets')).find((f) => f.endsWith('.js'));
    const src = fs.readFileSync(path.join(BUILD, 'assets', js), 'utf8');
    for (const marker of ['Benchmark inputs', 'Parameters', 'Pipeline progress', 'Gold replay', 'Download package', 'Other thresholds'])
      assert(src.includes(marker), `missing panel "${marker}"`);
  });

  await t('Interactive flow present: upload UI + empty-on-load + 8 status states', async () => {
    const assets = fs.readdirSync(path.join(BUILD, 'assets'));
    const js = fs.readFileSync(path.join(BUILD, 'assets', assets.find((f) => f.endsWith('.js'))), 'utf8');
    const css = fs.readFileSync(path.join(BUILD, 'assets', assets.find((f) => f.endsWith('.css'))), 'utf8');
    assert(js.includes('No results yet'), 'no empty-on-load guard');
    assert(js.includes('Run Validation'), 'no single Run Validation control');
    assert(js.includes('Pipeline progress'), 'no pipeline progress');
    assert(js.includes('Enter Console') && js.includes('Workflow phases'), 'LDT shell (home hero + phase sidebar) missing');
    assert(!/Run Phase II/.test(js), 'per-phase Run buttons should be gone (single Validation entry)');
    assert(js.includes('Use SpeakerX sample') || js.includes('Benchmark inputs'), 'no upload UI');
    assert(/api\/run/.test(js) && /api\/status/.test(js) && /api\/upload/.test(js), 'missing run/status/upload wiring');
    // the 8 status states are defined as CSS classes (JS builds the class name dynamically)
    for (const s of ['passed', 'failed', 'running', 'generated_no_gold', 'pending_gold', 'blocked', 'ready', 'idle'])
      assert(css.includes(`vc-s-${s}`), `missing status state vc-s-${s}`);
  });

  await t('Single Run Validation lights the phase pipeline (I→II→III→IV→V) then completes', async () => {
    await fetch(`${base}/api/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phase: 'all', useSample: true }) });
    let keys = new Set();
    let done = false;
    for (let i = 0; i < 50 && !done; i++) {
      const s = await (await fetch(`${base}/api/status`)).json();
      for (const x of s.steps || []) keys.add(x.key);
      done = !!s.done;
      await new Promise((r) => setTimeout(r, 300));
    }
    assert(done, 'run did not complete');
    for (const k of ['i', 'ii', 'iii', 'iv', 'v']) assert(keys.has(k), `pipeline missing phase ${k}`);
    const rep = await (await fetch(`${base}/api/report`)).json();
    assert(rep.phase_iv && rep.phase_iv.status === 'placeholder_ready', 'Phase IV not placeholder_ready');
  });

  await t('Phase II email fidelity: Script 1/2, 200 s window, Scale times, calculate_segment_durations, diagnostic', async () => {
    const assets = fs.readdirSync(path.join(BUILD, 'assets'));
    const js = fs.readFileSync(path.join(BUILD, 'assets', assets.find((f) => f.endsWith('.js'))), 'utf8');
    for (const m of ['Script 1', 'Script 2', 'calculate_segment_durations', 'Scale times', 'window', 'Other thresholds', 'Label contract'])
      assert(js.includes(m), `bundle missing "${m}"`);
    assert(report.phase_ii.praat_window_sec === 200, `window not 200: ${report.phase_ii.praat_window_sec}`);
    assert(report.phase_ii.scale_times, 'no scale_times in report');
    assert(Array.isArray(report.phase_ii.script1) && Array.isArray(report.phase_ii.script2), 'no script1/script2 arrays');
    assert(report.phase_ii.generated_vs_expert_025, 'no generated_vs_expert diagnostic');
    assert(JSON.stringify(report.phase_ii.label_contract) === JSON.stringify(['sounding', 'silent', 'invalid']), 'label contract wrong');
  });

  await t('0.35 never marked gold pass', async () => {
    const t035 = report.phase_ii.thresholds.find((x) => Number(x.threshold) === 0.35);
    assert(t035.status !== 'passed' && t035.kind !== 'gold', '0.35 marked as gold pass');
  });

  await t('Phase I shows skipped (monologue) in bundle', async () => {
    const js = fs.readdirSync(path.join(BUILD, 'assets')).find((f) => f.endsWith('.js'));
    const src = fs.readFileSync(path.join(BUILD, 'assets', js), 'utf8');
    assert(/skipped/.test(src) && /monologue/.test(src), 'no skipped-monologue copy');
  });

  await t('Desktop screenshot saved (> 10 KB)', async () => {
    const f = path.join(SHOTS, 'validation-console-desktop.png');
    assert(fs.existsSync(f) && fs.statSync(f).size > 10000, 'desktop screenshot missing/small');
  });
  await t('Mobile screenshot saved (> 10 KB)', async () => {
    const f = path.join(SHOTS, 'validation-console-mobile.png');
    assert(fs.existsSync(f) && fs.statSync(f).size > 10000, 'mobile screenshot missing/small');
  });

  const summary = {
    suite: 'ui',
    passed: cases.filter((c) => c.status === 'passed').length,
    failed: cases.filter((c) => c.status === 'failed').length,
    cases,
    screenshots: {
      desktop: path.join(SHOTS, 'validation-console-desktop.png'),
      mobile: path.join(SHOTS, 'validation-console-mobile.png'),
    },
    generated_at: new Date().toISOString(),
  };
  fs.mkdirSync(path.join(OUT_DIR, 'test-results'), { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'test-results', 'ui-test-results.json'), JSON.stringify(summary, null, 2));
  console.log(`\nUI: ${summary.passed} passed / ${summary.failed} failed`);
  process.exit(summary.failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
