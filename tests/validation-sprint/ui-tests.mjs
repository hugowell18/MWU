// UI tests: assert the built console + served report satisfy the status rules, and that screenshots exist.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
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

async function canReach(base) {
  try {
    const res = await fetch(`${base}/`);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForServer(base, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await canReach(base)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function ensureServer(port, base) {
  if (await canReach(base)) return null;

  const child = spawn(process.execPath, ['scripts/validation-sprint/server.mjs', '--port', String(port)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverLog = '';
  child.stdout.on('data', (chunk) => { serverLog += chunk.toString(); });
  child.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });

  if (await waitForServer(base)) return child;

  child.kill();
  throw new Error(`validation server did not start on ${base}${serverLog ? `\n${serverLog}` : ''}`);
}

function findBrowser() {
  const candidates = [
    process.env.BROWSER_BIN,
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p));
}

function runProcess(file, args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out: ${file}`));
    }, timeoutMs);
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`${path.basename(file)} exited ${code}${stderr ? `: ${stderr}` : ''}`));
    });
  });
}

async function ensureScreenshot(base, file, width, height) {
  if (fs.existsSync(file) && fs.statSync(file).size > 10000) return;
  const browser = findBrowser();
  assert(browser, 'no Edge/Chrome executable found for headless screenshot');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await runProcess(browser, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    `--window-size=${width},${height}`,
    `--screenshot=${file}`,
    `${base}/`,
  ]);
}

async function main() {
  console.log('UI TESTS');
  const port = process.env.VC_PORT || 4173;
  const base = `http://localhost:${port}`;
  const ownedServer = await ensureServer(port, base);

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

  await t('Multilogue v2 validation is grouped by input, pipeline, thresholds, evidence and package', async () => {
    const js = fs.readdirSync(path.join(BUILD, 'assets')).find((f) => f.endsWith('.js'));
    const src = fs.readFileSync(path.join(BUILD, 'assets', js), 'utf8');
    for (const marker of ['Multilogue04 v2', 'Input', 'Pipeline', 'P025', 'P035', 'Evidence & limitations', 'Download package'])
      assert(src.includes(marker), `missing v2 section "${marker}"`);
    assert(/api\/multilogue-v2\/input/.test(src) && /api\/multilogue-v2\/run/.test(src)
      && /api\/multilogue-v2\/status/.test(src) && /api\/multilogue-v2\/report/.test(src), 'v2 API wiring missing');
  });

  await t('Multilogue v2 exposes draft evidence without a final or human-gate action', async () => {
    const js = fs.readdirSync(path.join(BUILD, 'assets')).find((f) => f.endsWith('.js'));
    const src = fs.readFileSync(path.join(BUILD, 'assets', js), 'utf8');
    for (const marker of ['Draft integration evidence', 'Accuracy', 'Awaiting research team', 'Research categories'])
      assert(src.includes(marker), `missing draft boundary "${marker}"`);
    for (const removed of ['Mandatory human gate', 'Praat review / validation', 'Finalize reviewed L1b outputs', 'Reviewed deliverables'])
      assert(!src.includes(removed), `obsolete review UI remains: "${removed}"`);
    assert(!src.includes('/api/multilogue-v2/finalize'), 'v2 finalization endpoint leaked into UI');
  });

  await t('Formal Layer workspace is primary while benchmark runners remain internal regression tools', async () => {
    const js = fs.readdirSync(path.join(BUILD, 'assets')).find((f) => f.endsWith('.js'));
    const src = fs.readFileSync(path.join(BUILD, 'assets', js), 'utf8');
    const appSource = fs.readFileSync(path.join(ROOT, 'src/components/validation/ValidationApp.tsx'), 'utf8');
    for (const marker of ['Operational workspace', 'Delivery layers', 'Speaker Evidence', 'Interaction Timing', 'N+3 TextGrid'])
      assert(src.includes(marker), `missing formal workspace marker "${marker}"`);
    assert(appSource.includes("params.get('internal') === 'validation'") && appSource.includes('<InternalValidation'), 'internal regression route is missing');
    assert(!src.includes('Two benchmark runs, one validation workspace'), 'obsolete benchmark selector remains in the formal UI');
    assert(!/className="vc-pitem[^\n]+Validation/.test(appSource), 'benchmark validation remains in the formal layer navigation');
  });

  await t('Workspace usage panel reads the real provider ledger and exposes its counting rule', async () => {
    const js = fs.readdirSync(path.join(BUILD, 'assets')).find((f) => f.endsWith('.js'));
    const src = fs.readFileSync(path.join(BUILD, 'assets', js), 'utf8');
    for (const marker of ['Cumulative audio processing', 'Unique source audio', 'AssemblyAI processing', 'pyannoteAI processing', '/api/workspace/usage']) {
      assert(src.includes(marker), `usage panel missing "${marker}"`);
    }
    assert(!src.includes('Usage ledger pending'), 'static usage placeholder remains in the built UI');
    const usage = await (await fetch(`${base}/api/workspace/usage`)).json();
    assert(usage.schema_version === 'mwu-workspace-usage-summary-v1', 'workspace usage API schema missing');
    assert(typeof usage.allowance.used_hours === 'number' && usage.allowance.limit_hours > 0, 'workspace usage values are not numeric');
  });

  await t('Methodology Atlas is embedded as a versioned static academic reference', async () => {
    const js = fs.readdirSync(path.join(BUILD, 'assets')).find((f) => f.endsWith('.js'));
    const src = fs.readFileSync(path.join(BUILD, 'assets', js), 'utf8');
    const atlasPath = path.join(BUILD, 'methodology-atlas.html');
    assert(src.includes('Methodology Atlas') && src.includes('/methodology-atlas.html?embed=1#workflow'), 'Methodology menu or iframe is missing');
    assert(fs.existsSync(atlasPath), 'built methodology-atlas.html is missing');
    const atlas = fs.readFileSync(atlasPath, 'utf8');
    for (const marker of ['all acoustic candidates', 'dynamic N+3 draft', 'three-speaker Gold reference', 'Path B baseline', 'N muted mirrors'])
      assert(atlas.includes(marker), `methodology atlas missing "${marker}"`);
    for (const stale of ['current study: 3 fixed', 'Original WAV + task bounds + 3 fixed speaker IDs', 'P025/P035 six-tier TextGrids'])
      assert(!atlas.includes(stale), `methodology atlas retains stale fixed-three wording: "${stale}"`);
  });

  await t('Multilogue v2 regression API exposes either local evidence or an explicit blocker', async () => {
    const input = await (await fetch(`${base}/api/multilogue-v2/input`)).json();
    const reportV2 = await (await fetch(`${base}/api/multilogue-v2/report`)).json();
    if (input.ready) {
      assert(reportV2.status === 'ready_draft', `v2 status=${reportV2.status}`);
      assert(reportV2.accuracy === 'unavailable', `v2 accuracy=${reportV2.accuracy}`);
      assert(reportV2.thresholds.length === 2 && reportV2.thresholds.every((item) => item.praat.passed), 'two Praat-readable thresholds absent');
    } else {
      const missing = (input.required_files_present || []).filter((item) => item.present === false);
      assert(missing.length > 0, 'missing regression input has no explicit missing-file evidence');
    }
  });

  await t('Interactive flow present: formal overview + four-layer workspace + internal regression controls', async () => {
    const assets = fs.readdirSync(path.join(BUILD, 'assets'));
    const js = fs.readFileSync(path.join(BUILD, 'assets', assets.find((f) => f.endsWith('.js'))), 'utf8');
    const css = fs.readFileSync(path.join(BUILD, 'assets', assets.find((f) => f.endsWith('.css'))), 'utf8');
    assert(js.includes('No results yet'), 'no empty-on-load guard');
    assert(js.includes('Run Validation'), 'no single Run Validation control');
    assert(js.includes('Pipeline progress'), 'no pipeline progress');
    assert(js.includes('From multilogue audio to reviewable research evidence') && js.includes('Five-stage research workflow'), 'formal MWU homepage missing');
    assert(js.includes('Open Layer 1a') && js.includes('Review Layer 1b'), 'formal Layer 1 CTAs missing');
    assert(js.includes('Delivery layers'), 'layer sidebar missing');
    for (const marker of [
      'Original room-mix WAV',
      'Researcher candidate decisions',
      'Accepted L1a handoff and canonical S1-SN evidence',
      'One dynamic N+3-tier TextGrid per threshold',
      'Nine timeline labels',
      'overlap present with offset not measured',
      'never serialize missing FTO as zero',
      'R1 start FREE',
      'R2 claim floor',
      'R5 resolve silence',
    ])
      assert(js.includes(marker), `formal Layer contract missing "${marker}"`);
    assert(!/Run Phase II/.test(js), 'per-phase Run buttons should be gone (single Validation entry)');
    assert(js.includes('Use SpeakerX sample') || js.includes('Benchmark inputs'), 'no upload UI');
    assert(/api\/run/.test(js) && /api\/status/.test(js) && /api\/upload/.test(js), 'missing run/status/upload wiring');
    // the 8 status states are defined as CSS classes (JS builds the class name dynamically)
    for (const s of ['passed', 'failed', 'running', 'generated_no_gold', 'pending_gold', 'blocked', 'ready', 'idle', 'ready_for_praat_review'])
      assert(css.includes(`vc-s-${s}`), `missing status state vc-s-${s}`);
  });

  await t('Single Run Validation lights the phase pipeline (I→II→III→IV→V) then completes', async () => {
    await fetch(`${base}/api/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phase: 'all', useSample: true, noAsr: true }) });
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
    if (report.phase_ii.generated_vs_expert_025) {
      assert(report.phase_ii.generated_vs_expert_025.status === 'diagnostic', 'generated_vs_expert is not diagnostic');
    } else {
      assert(report.praat && report.praat.available === false, 'no generated_vs_expert diagnostic although Praat is available');
      assert(report.phase_ii.thresholds.every((x) => x.status === 'blocked'), 'missing diagnostic should only happen when generated drafts are blocked');
    }
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
    await ensureScreenshot(base, f, 1440, 1100);
    assert(fs.existsSync(f) && fs.statSync(f).size > 10000, 'desktop screenshot missing/small');
  });
  await t('Mobile screenshot saved (> 10 KB)', async () => {
    const f = path.join(SHOTS, 'validation-console-mobile.png');
    await ensureScreenshot(base, f, 390, 1100);
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
  if (ownedServer) ownedServer.kill();
  process.exit(summary.failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
