#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROGRESS_ORDER } from '../../scripts/multilogue-v2/run-validation-poc.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../..');
const ARTIFACT_DIR = path.join(TEST_DIR, 'artifacts');
const OUTPUT_DIR = path.join(ROOT, 'output', 'playwright');
const REPORT_FILE = path.join(ARTIFACT_DIR, 'browser-qa-report.json');
const BASE = process.env.G3_BROWSER_BASE || 'http://127.0.0.1:4173';
const URL = `${BASE}/?view=console&validation=multilogue-v2`;
const PW = path.join(process.env.HOME, '.codex', 'skills', 'playwright', 'scripts', 'playwright_cli.sh');
const SESSION = `g3-browser-qa-${process.pid}`;

function cli(command, args = []) {
  const result = spawnSync(PW, [`-s=${SESSION}`, command, ...args, '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, npm_config_offline: 'true' },
  });
  if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout).trim()}`);
  const output = JSON.parse(result.stdout || '{}');
  if (typeof output.result === 'string') {
    const trimmed = output.result.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { return JSON.parse(trimmed); } catch { /* preserve raw result */ }
    }
  }
  return output.result ?? output;
}

function statusFromChecks(checks) {
  return Object.values(checks).every(Boolean) ? 'pass' : 'fail';
}

function screenshotRecord(relative) {
  const absolute = path.join(ROOT, relative);
  return {
    path: relative,
    exists: existsSync(absolute),
    bytes: existsSync(absolute) ? statSync(absolute).size : 0,
  };
}

const DOM_QA = `() => {
  const root = document.documentElement;
  const bodyText = document.body.innerText;
  const rect = (element) => {
    const value = element.getBoundingClientRect();
    return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
  };
  const criticalSelectors = ['.m2-page', '.m2-status-strip', '.m2-threshold-grid', '.m2-threshold', '.m2-package', '.vc-runbtn'];
  const critical = criticalSelectors.flatMap((selector) => [...document.querySelectorAll(selector)].map((element, index) => ({ selector, index, ...rect(element) })));
  const criticalWithinPage = critical.length > 0 && critical.every((item) => item.left >= -1 && item.right <= root.clientWidth + 1 && item.width > 0);
  const textControls = [...document.querySelectorAll('.vc-runbtn,.m2-download,.m2-section-head>b,.m2-status strong')];
  const textFits = textControls.length > 0 && textControls.every((element) => element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1);
  const keyTexts = {
    draft_evidence: bodyText.includes('Draft integration evidence'),
    accuracy: bodyText.includes('Accuracy') && bodyText.includes('Unavailable'),
    duration_six_decimals: (bodyText.match(/501\\.013333s/g) || []).length >= 3 && !bodyText.includes('501.013333 s'),
    p025: bodyText.includes('P025'),
    p035: bodyText.includes('P035'),
    ol_unavailable: bodyText.includes('ol unavailable'),
    x_unavailable: bodyText.includes('x unavailable'),
    download_zip: bodyText.includes('Download ZIP'),
  };
  const tables = [...document.querySelectorAll('.m2-label-table')].map((table) => ({
    headers: [...table.querySelectorAll('thead th')].map((cell) => cell.textContent.trim()),
    ...rect(table),
  }));
  const expectedHeaders = ['Speaker', 's', 'f', 'bc', 'op', 'pf', 'tr', 'shs'];
  const allSevenLabels = tables.length === 2 && tables.every((table) => JSON.stringify(table.headers) === JSON.stringify(expectedHeaders));
  const wraps = [...document.querySelectorAll('.m2-table-wrap')].map((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    overflowX: getComputedStyle(element).overflowX,
    scrollbarWidth: getComputedStyle(element).scrollbarWidth,
    webkitScrollbarHeight: getComputedStyle(element, '::-webkit-scrollbar').height,
  }));
  return {
    viewport: { innerWidth, innerHeight, clientWidth: root.clientWidth, scrollWidth: root.scrollWidth },
    page_no_horizontal_overflow: root.scrollWidth <= root.clientWidth + 1,
    critical_within_page: criticalWithinPage,
    text_controls_fit: textFits,
    key_texts: keyTexts,
    all_key_texts_visible: Object.values(keyTexts).every(Boolean),
    table_count: tables.length,
    all_seven_labels: allSevenLabels,
    desktop_tables_fully_visible: wraps.length === 2 && wraps.every((item) => item.scrollWidth <= item.clientWidth + 1),
    mobile_internal_scroll: wraps.length === 2 && wraps.every((item) => item.scrollWidth > item.clientWidth + 1 && item.overflowX === 'auto'),
    mobile_scrollbar_hint: wraps.length === 2 && wraps.every((item) => item.scrollbarWidth === 'thin' || parseFloat(item.webkitScrollbarHeight) > 0),
    critical,
    tables,
    wraps,
  };
}`;

async function main() {
  const health = await fetch(`${BASE}/api/multilogue-v2/input`);
  if (!health.ok) throw new Error(`4173 validation server is not ready: HTTP ${health.status}`);
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });

  let actualUiRun = null;
  const viewports = {};
  try {
    cli('open', [URL]);
    actualUiRun = cli('run-code', [`async (page) => {
      await page.getByRole('button', { name: 'Run draft validation' }).click();
      await page.getByRole('button', { name: 'Running locally' }).waitFor({ timeout: 10000 });
      await page.getByRole('button', { name: 'Run draft validation' }).waitFor({ timeout: 120000 });
      return page.evaluate(async () => {
        const status = await (await fetch('/api/multilogue-v2/status')).json();
        return { status: status.status, done: status.done, event_keys: (status.events || []).map((event) => event.key) };
      });
    }`]);
    if (actualUiRun.status !== 'ready_draft' || JSON.stringify(actualUiRun.event_keys) !== JSON.stringify(PROGRESS_ORDER)) {
      throw new Error(`UI run returned invalid progress: ${JSON.stringify(actualUiRun)}`);
    }

    for (const viewport of [
      { key: 'desktop', width: 1440, height: 1000, screenshot: 'output/playwright/multilogue-v2-desktop.png' },
      { key: 'mobile', width: 390, height: 844, screenshot: 'output/playwright/multilogue-v2-mobile.png' },
    ]) {
      cli('resize', [String(viewport.width), String(viewport.height)]);
      cli('reload');
      const dom = cli('eval', [DOM_QA]);
      const consoleText = String(cli('console', ['warning']) || '');
      const counts = /Errors:\s*(\d+),\s*Warnings:\s*(\d+)/.exec(consoleText);
      const consoleEvidence = {
        errors: counts ? Number(counts[1]) : null,
        warnings: counts ? Number(counts[2]) : null,
        raw: consoleText,
      };
      cli('screenshot', ['--filename', viewport.screenshot, '--full-page']);
      const checks = {
        viewport_exact: dom.viewport.innerWidth === viewport.width && dom.viewport.innerHeight === viewport.height,
        page_no_horizontal_overflow: dom.page_no_horizontal_overflow,
        critical_within_page: dom.critical_within_page,
        text_controls_fit: dom.text_controls_fit,
        all_key_texts_visible: dom.all_key_texts_visible,
        all_seven_labels: dom.all_seven_labels,
        table_layout: viewport.key === 'desktop' ? dom.desktop_tables_fully_visible : dom.mobile_internal_scroll,
        mobile_scrollbar_hint: viewport.key === 'desktop' || dom.mobile_scrollbar_hint,
        console_clean: consoleEvidence.errors === 0 && consoleEvidence.warnings === 0,
      };
      viewports[viewport.key] = {
        status: statusFromChecks(checks),
        expected: { width: viewport.width, height: viewport.height },
        checks,
        dom,
        console: consoleEvidence,
        screenshot: screenshotRecord(viewport.screenshot),
      };
    }
  } finally {
    try { cli('close'); } catch { /* best effort cleanup */ }
  }

  const report = {
    suite: 'multilogue-v2-g3-browser-qa',
    status: Object.values(viewports).every((viewport) => viewport.status === 'pass') ? 'pass' : 'fail',
    actual_ui_run: actualUiRun,
    viewports,
    generated_at: new Date().toISOString(),
  };
  writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, actual_ui_run: report.actual_ui_run, checks: Object.fromEntries(Object.entries(viewports).map(([key, value]) => [key, value.checks])) }, null, 2));
  if (report.status !== 'pass') process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
