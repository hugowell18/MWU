#!/usr/bin/env node

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SERVER = path.join(ROOT, 'scripts', 'validation-sprint', 'server.mjs');
const ARTIFACT_DIR = path.join(ROOT, 'tests', 'l1a', 'artifacts');
const PLAYWRIGHT = path.join(process.env.HOME, '.codex', 'skills', 'playwright', 'scripts', 'playwright_cli.sh');
const SESSION = `mwu-l1a-browser-${process.pid}`;

function wavBuffer({ seconds = 2.4, sampleRate = 16000 } = {}) {
  const frames = Math.floor(seconds * sampleRate);
  const dataSize = frames * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      socket.close(() => resolve(address.port));
    });
    socket.on('error', reject);
  });
}

async function waitForServer(baseUrl) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}/api/l1a/runs`)).ok) return;
    } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('L1a browser QA server did not start');
}

function cli(command, args = []) {
  const result = spawnSync(PLAYWRIGHT, [`-s=${SESSION}`, command, ...args, '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, npm_config_offline: 'true' },
  });
  if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout).trim()}`);
  const output = JSON.parse(result.stdout || '{}');
  if (typeof output.result === 'string' && /^[\[{]/.test(output.result.trim())) {
    try { return JSON.parse(output.result); } catch { /* preserve text */ }
  }
  return output.result ?? output;
}

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const build = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'validation-sprint', 'build-ui.mjs')], { cwd: ROOT, stdio: 'inherit' });
  if (build.status !== 0) throw new Error('Validation UI build failed before browser QA');

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mwu-l1a-browser-'));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [SERVER, '--port', String(port)], {
    cwd: ROOT,
    env: {
      ...process.env,
      MWU_L1A_TEST_MODE: '1',
      MWU_L1A_ROOT: path.join(temporary, 'accepted', 'sessions'),
      MWU_MULTILOGUE_OUT: path.join(temporary, 'accepted'),
      MWU_L1B_ROOT: path.join(temporary, 'l1b'),
    },
    stdio: 'ignore',
  });

  const report = {
    schema_version: 'l1a-browser-qa-v1',
    generated_at: new Date().toISOString(),
    requirements: ['UI-006', 'L1A-003', 'L1A-004', 'L1A-005', 'L1A-006', 'L1A-009'],
    status: 'fail',
    checks: {},
    screenshots: [],
    data_boundary: 'Synthetic WAV and test-mode candidate turns only.',
  };

  try {
    await waitForServer(baseUrl);
    const browserFixture = path.join(temporary, 'browser-fixture.wav');
    fs.writeFileSync(browserFixture, wavBuffer());

    cli('open', [`${baseUrl}/?layer=l1a`]);
    const interaction = cli('run-code', [`async (page) => {
      await page.getByRole('heading', { name: 'Speaker evidence and participant review' }).waitFor({ timeout: 15000 });
      const initial = {
        generateDisabled: await page.getByRole('button', { name: 'Generate candidates' }).isDisabled(),
        reviewerDisabled: await page.getByPlaceholder('Available after generation').isDisabled(),
        finalDisabled: await page.getByRole('button', { name: 'Accept mapping & build outputs' }).isDisabled()
      };
      await page.locator('input[type="file"]').setInputFiles(${JSON.stringify(browserFixture)});
      const generateEnabledAfterBrowse = await page.getByRole('button', { name: 'Generate candidates' }).isEnabled();
      await page.getByRole('button', { name: 'Generate candidates' }).click();
      await page.locator('.l1a-table tbody tr').filter({ has: page.locator('select') }).first().waitFor({ timeout: 15000 });
      const flowBeforeAcceptance = {
        reviewRunning: await page.locator('.l1a-flow-step').nth(2).evaluate((element) => element.classList.contains('running')),
        mappingPending: await page.locator('.l1a-flow-step').nth(3).evaluate((element) => element.classList.contains('pending')),
        artifactsPending: await page.locator('.l1a-flow-step').nth(4).evaluate((element) => element.classList.contains('pending'))
      };
      await page.getByPlaceholder('Enter assigned ID').fill('browser-rater-01');
      const rows = page.locator('.l1a-table tbody tr').filter({ has: page.locator('select') });
      const count = await rows.count();
      const defaultsApplied = await rows.evaluateAll((items) => items.every((row, index) => {
        const selects = row.querySelectorAll('select');
        const canonical = row.querySelector('[aria-label$="canonical speaker"]');
        return selects[0]?.value === 'participant'
          && selects[1]?.value === 'include'
          && canonical?.textContent === 'S' + (index + 1);
      }));
      const prefilledCount = await page.getByText('Prefilled', { exact: true }).count();
      let exclusionRenumbered = true;
      if (count >= 3) {
        await rows.nth(1).getByLabel(/review decision/).selectOption('exclude');
        exclusionRenumbered = await rows.evaluateAll((items) => {
          const labels = items.map((row) => row.querySelector('[aria-label$="canonical speaker"]')?.textContent || null);
          return labels[0] === 'S1' && labels[1] === null && labels[2] === 'S2';
        });
        await rows.nth(1).getByLabel(/review decision/).selectOption('include');
      }
      await page.locator('.l1a-clips button').first().click();
      await page.waitForTimeout(150);
      const playing = await page.locator('audio').evaluate((audio) => !audio.paused || audio.currentTime > 0);
      await page.getByRole('button', { name: 'Accept mapping & build outputs' }).click();
      await page.getByText('L1a human gate is complete').waitFor({ timeout: 15000 });
      const flowAfterAcceptance = {
        reviewPassed: await page.locator('.l1a-flow-step').nth(2).evaluate((element) => element.classList.contains('passed')),
        mappingPassed: await page.locator('.l1a-flow-step').nth(3).evaluate((element) => element.classList.contains('passed')),
        artifactsPassed: await page.locator('.l1a-flow-step').nth(4).evaluate((element) => element.classList.contains('passed'))
      };
      return { initial, generateEnabledAfterBrowse, candidate_count: count, defaultsApplied, exclusionRenumbered, prefilledCount, playing, flowBeforeAcceptance, flowAfterAcceptance, reviewer: await page.getByPlaceholder('Enter assigned ID').inputValue() };
    }`]);

    const viewports = [
      { key: 'desktop', width: 1440, height: 1000 },
      { key: 'mobile', width: 390, height: 844 },
    ];
    const viewportChecks = {};
    for (const viewport of viewports) {
      cli('resize', [String(viewport.width), String(viewport.height)]);
      const dom = cli('eval', [`() => ({
        innerWidth,
        pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        headingVisible: !!document.querySelector('.l1a-head h1'),
        reviewerVisible: !!document.querySelector('.l1a-reviewer input'),
        acceptedVisible: document.body.innerText.includes('L1a human gate is complete'),
        outputLinks: document.querySelectorAll('.l1a-output-row a').length,
        reviewerValue: document.querySelector('.l1a-reviewer input')?.value || ''
      })`]);
      const screenshot = path.join('tests', 'l1a', 'artifacts', `l1a-browser-${viewport.key}.png`);
      cli('screenshot', ['--filename', screenshot, '--full-page']);
      viewportChecks[viewport.key] = {
        ...dom,
        expected_width: viewport.width,
        ok: dom.innerWidth === viewport.width && !dom.pageOverflow && dom.headingVisible && dom.reviewerVisible && dom.acceptedVisible && dom.outputLinks === 6 && dom.reviewerValue === 'browser-rater-01',
      };
      report.screenshots.push({ path: screenshot, bytes: fs.statSync(path.join(ROOT, screenshot)).size });
    }
    const secondFixture = path.join(temporary, 'second-import.wav');
    fs.writeFileSync(secondFixture, wavBuffer({ seconds: 1.6 }));
    const secondImport = cli('run-code', [`async (page) => {
      await page.locator('input[type="file"]').setInputFiles(${JSON.stringify(secondFixture)});
      await page.waitForTimeout(100);
      return {
        passedSteps: await page.locator('.l1a-flow-step.passed').count(),
        runningSteps: await page.locator('.l1a-flow-step.running').count(),
        candidateRows: await page.locator('.l1a-table tbody tr').filter({ has: page.locator('select') }).count(),
        selectedFileVisible: await page.getByText('second-import.wav', { exact: true }).count(),
        acceptedGateVisible: await page.getByText('L1a human gate is complete', { exact: true }).count()
      };
    }`]);
    const consoleText = String(cli('console', ['warning']) || '');
    const counts = /Errors:\s*(\d+),\s*Warnings:\s*(\d+)/.exec(consoleText);
    report.checks = {
      three_candidates_reviewed: interaction.candidate_count === 3,
      progressive_controls: interaction.initial.generateDisabled === true
        && interaction.initial.reviewerDisabled === true
        && interaction.initial.finalDisabled === true
        && interaction.generateEnabledAfterBrowse === true,
      candidate_defaults_applied: interaction.defaultsApplied === true && interaction.prefilledCount === 3,
      exclusion_reindexes_canonical_speakers: interaction.exclusionRenumbered === true,
      phase_evidence_state_machine: interaction.flowBeforeAcceptance.reviewRunning === true
        && interaction.flowBeforeAcceptance.mappingPending === true
        && interaction.flowBeforeAcceptance.artifactsPending === true
        && interaction.flowAfterAcceptance.reviewPassed === true
        && interaction.flowAfterAcceptance.mappingPassed === true
        && interaction.flowAfterAcceptance.artifactsPassed === true,
      representative_audio_playback: interaction.playing === true,
      reviewer_persisted: interaction.reviewer === 'browser-rater-01',
      accepted_artifacts_visible: Object.values(viewportChecks).every((value) => value.ok),
      second_upload_resets_prior_session: secondImport.passedSteps === 0
        && secondImport.runningSteps === 0
        && secondImport.candidateRows === 0
        && secondImport.selectedFileVisible > 0
        && secondImport.acceptedGateVisible === 0,
      console_clean: counts ? Number(counts[1]) === 0 && Number(counts[2]) === 0 : false,
      viewport_checks: viewportChecks,
    };
    report.status = Object.entries(report.checks).filter(([key]) => key !== 'viewport_checks').every(([, value]) => value === true) ? 'pass' : 'fail';
  } finally {
    try { cli('close'); } catch { /* best effort */ }
    server.kill('SIGTERM');
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'l1a-browser-qa.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  console.log(JSON.stringify({ status: report.status, checks: report.checks, screenshots: report.screenshots }, null, 2));
  if (report.status !== 'pass') process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
