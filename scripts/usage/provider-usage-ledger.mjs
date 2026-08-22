import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

export const LEDGER_SCHEMA = 'mwu-provider-usage-ledger-v1';
export const SUMMARY_SCHEMA = 'mwu-workspace-usage-summary-v1';

const PROVIDERS = new Set(['assemblyai', 'pyannoteai']);

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function percentage(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : fallback;
}

export function usageConfig(env = process.env) {
  return {
    ledgerPath: path.resolve(env.MWU_USAGE_LEDGER || path.join(ROOT, 'outputs', 'usage', 'provider-usage-ledger.json')),
    limitHours: positiveNumber(env.MWU_USAGE_LIMIT_HOURS, 100),
    warningPercent: percentage(env.MWU_USAGE_WARNING_PERCENT, 80),
    criticalPercent: percentage(env.MWU_USAGE_CRITICAL_PERCENT, 95),
  };
}

function newLedger(now = new Date().toISOString()) {
  return {
    schema_version: LEDGER_SCHEMA,
    tracking_started_at: now,
    historical_backfill: false,
    events: [],
  };
}

function validateLedger(ledger, ledgerPath) {
  if (!ledger || ledger.schema_version !== LEDGER_SCHEMA || !Array.isArray(ledger.events)) {
    throw new Error(`Invalid provider usage ledger: ${ledgerPath}`);
  }
  return ledger;
}

function readLedger(ledgerPath, { create = true } = {}) {
  if (!fs.existsSync(ledgerPath)) {
    const ledger = newLedger();
    if (create) writeLedger(ledgerPath, ledger);
    return ledger;
  }
  return validateLedger(JSON.parse(fs.readFileSync(ledgerPath, 'utf8')), ledgerPath);
}

function writeLedger(ledgerPath, ledger) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const tempPath = `${ledgerPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempPath, ledgerPath);
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function round(value, places = 6) {
  const factor = 10 ** places;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

export async function recordProviderUsage({
  provider,
  jobId,
  durationSeconds,
  sourceAudioPath,
  requestedModel = null,
  actualModel = null,
  context = null,
  runId = null,
  ledgerPath = usageConfig().ledgerPath,
  recordedAt = new Date().toISOString(),
}) {
  const normalizedProvider = String(provider || '').toLowerCase();
  if (!PROVIDERS.has(normalizedProvider)) throw new Error(`Unsupported usage provider: ${provider}`);
  if (!jobId) throw new Error('Provider usage requires a remote job ID');
  if (!Number.isFinite(Number(durationSeconds)) || Number(durationSeconds) <= 0) {
    throw new Error(`Provider usage requires a positive duration: ${durationSeconds}`);
  }

  const resolvedAudio = path.resolve(sourceAudioPath || '');
  if (!sourceAudioPath || !fs.existsSync(resolvedAudio)) {
    throw new Error(`Provider usage source audio does not exist: ${sourceAudioPath || '[missing]'}`);
  }

  const idempotencyKey = `${normalizedProvider}:${jobId}`;
  const ledger = readLedger(ledgerPath);
  const existing = ledger.events.find((event) => event.idempotency_key === idempotencyKey);
  if (existing) return { recorded: false, event: existing };

  const stats = fs.statSync(resolvedAudio);
  const event = {
    event_id: crypto.randomUUID(),
    idempotency_key: idempotencyKey,
    provider: normalizedProvider,
    status: 'completed',
    duration_seconds: round(durationSeconds, 3),
    source_audio: {
      basename: path.basename(resolvedAudio),
      sha256: await sha256File(resolvedAudio),
      bytes: stats.size,
    },
    requested_model: requestedModel || null,
    actual_model: actualModel || requestedModel || null,
    job_id: String(jobId),
    context: context || null,
    run_id: runId || null,
    recorded_at: recordedAt,
  };

  ledger.events.push(event);
  writeLedger(ledgerPath, ledger);
  return { recorded: true, event };
}

export function summarizeProviderUsage({
  ledgerPath,
  limitHours,
  warningPercent,
  criticalPercent,
} = {}) {
  const defaults = usageConfig();
  const config = {
    ledgerPath: path.resolve(ledgerPath || defaults.ledgerPath),
    limitHours: positiveNumber(limitHours, defaults.limitHours),
    warningPercent: percentage(warningPercent, defaults.warningPercent),
    criticalPercent: percentage(criticalPercent, defaults.criticalPercent),
  };
  if (config.criticalPercent < config.warningPercent) {
    throw new Error('MWU_USAGE_CRITICAL_PERCENT must be greater than or equal to MWU_USAGE_WARNING_PERCENT');
  }

  const ledger = readLedger(config.ledgerPath);
  const providerSeconds = { assemblyai: 0, pyannoteai: 0 };
  const providerCalls = { assemblyai: 0, pyannoteai: 0 };
  const uniqueSources = new Map();
  let processingSeconds = 0;

  for (const event of ledger.events) {
    if (event.status !== 'completed' || !PROVIDERS.has(event.provider)) continue;
    const seconds = Number(event.duration_seconds);
    if (!Number.isFinite(seconds) || seconds <= 0) continue;
    processingSeconds += seconds;
    providerSeconds[event.provider] += seconds;
    providerCalls[event.provider] += 1;
    const sourceHash = event.source_audio?.sha256;
    if (sourceHash && !uniqueSources.has(sourceHash)) uniqueSources.set(sourceHash, seconds);
  }

  const sourceSeconds = [...uniqueSources.values()].reduce((sum, seconds) => sum + seconds, 0);
  const usedHours = processingSeconds / 3600;
  const usagePercent = config.limitHours > 0 ? (usedHours / config.limitHours) * 100 : 0;
  const state = usagePercent >= 100
    ? 'exceeded'
    : usagePercent >= config.criticalPercent
      ? 'critical'
      : usagePercent >= config.warningPercent
        ? 'warning'
        : 'normal';

  return {
    schema_version: SUMMARY_SCHEMA,
    tracking_started_at: ledger.tracking_started_at,
    historical_backfill: ledger.historical_backfill === true,
    allowance: {
      limit_hours: round(config.limitHours, 3),
      used_hours: round(usedHours, 3),
      remaining_hours: round(Math.max(0, config.limitHours - usedHours), 3),
      usage_percent: round(usagePercent, 2),
      state,
      warning_percent: config.warningPercent,
      critical_percent: config.criticalPercent,
    },
    source_audio: {
      unique_files: uniqueSources.size,
      unique_hours: round(sourceSeconds / 3600, 3),
    },
    providers: {
      assemblyai: { hours: round(providerSeconds.assemblyai / 3600, 3), calls: providerCalls.assemblyai },
      pyannoteai: { hours: round(providerSeconds.pyannoteai / 3600, 3), calls: providerCalls.pyannoteai },
    },
    completed_calls: providerCalls.assemblyai + providerCalls.pyannoteai,
    last_recorded_at: ledger.events.at(-1)?.recorded_at || null,
    counting_rule: 'Each completed provider invocation counts its full source-audio duration. Reprocessing counts again.',
  };
}
