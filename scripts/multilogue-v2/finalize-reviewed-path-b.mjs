#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CSV_SCHEMAS, EPSILON, SPEAKERS, canonicalJson, phonationIncluded, round } from './core/contracts.mjs';
import { serializeTextGrid } from './core/textgrid.mjs';
import { validateSixTierTextGrid } from './core/validator.mjs';
import { sha256File, writeCanonicalJson, writeFrozenCsv } from './io/artifact-utils.mjs';
import { parseSixTierTextGridFile } from './io/parse-six-tier-textgrid.mjs';

const ATTESTATION_SCHEMA = 'multilogue-v2-review-attestation';
const ATTESTATION_VERSION = '1.0';
const REQUIRED_REVIEWED_TIERS = Object.freeze(['S1', 'S2', 'S3', 'floor', 'flags']);
const BOUNDARY_TOLERANCE_SECONDS = 0.000001;

export function finalizeReviewedPathB({
  sourceDraftPath,
  reviewedTextGridPath,
  attestationPath,
  threshold,
  outputDir,
  recordingId = 'reviewed-recording',
  taskId = 'whole-recording-single-task',
} = {}) {
  requireFile(sourceDraftPath, 'source draft TextGrid');
  requireFile(reviewedTextGridPath, 'researcher-reviewed six-tier TextGrid');
  requireFile(attestationPath, 'review attestation JSON');
  const thresholdSec = Number(threshold);
  if (!(thresholdSec > 0)) throw new Error('a positive threshold is required');
  if (!outputDir) throw new Error('outputDir is required');

  const sourceDraftSha256 = sha256File(sourceDraftPath);
  const reviewedSha256 = sha256File(reviewedTextGridPath);
  const attestationSha256 = sha256File(attestationPath);
  if (sourceDraftSha256 === reviewedSha256) {
    throw new Error('reviewed TextGrid digest equals the source draft; explicit reviewed changes are required');
  }
  const attestation = JSON.parse(readFileSync(attestationPath, 'utf8'));
  validateAttestationEnvelope(attestation, {
    sourceDraftSha256,
    reviewedSha256,
    thresholdSec,
  });

  const sourceDraft = parseSixTierTextGridFile(sourceDraftPath);
  const sourceValidation = validateSixTierTextGrid(sourceDraft);
  if (!sourceValidation.valid) throw new Error(`source draft validation failed: ${sourceValidation.errors.join('; ')}`);
  const reviewed = parseSixTierTextGridFile(reviewedTextGridPath);
  if (Math.abs(sourceDraft.xmax - reviewed.xmax) > BOUNDARY_TOLERANCE_SECONDS) {
    throw new Error('reviewed TextGrid duration differs from source draft');
  }
  const reviewedValidation = validateReviewedStructure(reviewed);
  if (!reviewedValidation.valid) {
    throw new Error(`reviewed TextGrid validation failed: ${reviewedValidation.errors.join('; ')}`);
  }
  assertTier6Resolved(reviewed);

  const verified = verifyAttestedTransitions(reviewed, attestation.transition_boundary_decisions);
  const outputDocument = {
    ...reviewed,
    tiers: reviewed.tiers.map((tier) => tier.name === 'transitions'
      ? { ...tier, points: verified.transitions.map((transition) => ({ number: transition.point_time, mark: transition.label })) }
      : tier),
  };
  const finalValidation = validateSixTierTextGrid(outputDocument, { transitionStatuses: ['final'] });
  if (!finalValidation.valid) throw new Error(`final TextGrid validation failed: ${finalValidation.errors.join('; ')}`);

  mkdirSync(outputDir, { recursive: true });
  const thresholdKey = deliveryThresholdKey(thresholdSec);
  const stem = `${safeIdentifier(recordingId, 'recordingId')}.${thresholdKey}`;
  const textGridName = `${stem}.final.6tier.TextGrid`;
  const transitionName = 'final_fto_transitions.csv';
  const flagName = 'finalization_flags.csv';
  const auditName = 'finalization-audit-manifest.json';
  const reportName = 'finalization-report.json';
  const transitionRows = verified.transitions.map((transition, index) => ({
    recording_id: recordingId,
    task_id: taskId,
    threshold_sec: round(thresholdSec),
    sequence: index + 1,
    from_speaker: transition.from,
    to_speaker: transition.to,
    outgoing_offset_sec: transition.outgoing_offset,
    incoming_onset_sec: transition.incoming_onset,
    fto_sec: transition.fto,
    sign: transition.fto < 0 ? 'negative' : transition.fto > 0 ? 'positive' : 'zero',
    status: 'final',
    review_required: false,
  }));
  const finalizationFlags = [];
  writeFileSync(path.join(outputDir, textGridName), serializeTextGrid(outputDocument));
  writeFrozenCsv(path.join(outputDir, transitionName), CSV_SCHEMAS.fto_transitions, transitionRows);
  writeFrozenCsv(path.join(outputDir, flagName), CSV_SCHEMAS.flags, finalizationFlags);
  const auditManifest = {
    contract: 'multilogue-v2-path-b-finalization-v2',
    threshold_sec: round(thresholdSec),
    provenance: {
      source_draft: { artifact: path.basename(sourceDraftPath), sha256: sourceDraftSha256 },
      reviewed_textgrid: { artifact: path.basename(reviewedTextGridPath), sha256: reviewedSha256 },
      review_attestation: {
        artifact: path.basename(attestationPath),
        sha256: attestationSha256,
        schema: attestation.schema,
        version: attestation.version,
        reviewer_role: attestation.reviewer_role,
        review_status: attestation.review_status,
      },
    },
    verified_transition_boundaries: verified.transitions.map((transition) => ({
      sequence: transition.sequence,
      from: transition.from,
      to: transition.to,
      floor_departure_sec: transition.floor_departure,
      floor_acquisition_sec: transition.floor_acquisition,
      outgoing_offset_sec: transition.outgoing_offset,
      incoming_onset_sec: transition.incoming_onset,
      fto_sec: transition.fto,
    })),
    outputs: {
      final_textgrid: { artifact: textGridName, sha256: sha256File(path.join(outputDir, textGridName)) },
      final_transitions: { artifact: transitionName, sha256: sha256File(path.join(outputDir, transitionName)) },
      finalization_flags: { artifact: flagName, sha256: sha256File(path.join(outputDir, flagName)) },
    },
    validation: {
      source_draft: sourceValidation,
      reviewed_textgrid: reviewedValidation,
      final_textgrid: finalValidation,
      tier6_resolved: true,
      attestation_checks_passed: true,
    },
    network_used: false,
  };
  writeCanonicalJson(path.join(outputDir, auditName), auditManifest);
  const auditManifestSha256 = sha256File(path.join(outputDir, auditName));
  const report = {
    status: 'finalized_from_attested_researcher_boundaries',
    threshold_sec: round(thresholdSec),
    transition_count: transitionRows.length,
    positive_count: transitionRows.filter((row) => row.sign === 'positive').length,
    zero_count: transitionRows.filter((row) => row.sign === 'zero').length,
    negative_count: transitionRows.filter((row) => row.sign === 'negative').length,
    unresolved_count: 0,
    output: {
      textgrid: textGridName,
      transitions: transitionName,
      flags: flagName,
      audit_manifest: auditName,
      audit_manifest_sha256: auditManifestSha256,
    },
    accuracy: 'not_computed',
    network_used: false,
  };
  writeCanonicalJson(path.join(outputDir, reportName), report);
  return { report, auditManifest, document: outputDocument, transitionRows };
}

export function validateAttestationEnvelope(attestation, {
  sourceDraftSha256,
  reviewedSha256,
  thresholdSec,
}) {
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) {
    throw new Error('review attestation must be a JSON object');
  }
  if (attestation.schema !== ATTESTATION_SCHEMA || attestation.version !== ATTESTATION_VERSION) {
    throw new Error('unsupported review attestation schema/version');
  }
  if (attestation.source_draft_sha256 !== sourceDraftSha256) throw new Error('source draft checksum mismatch');
  if (attestation.reviewed_textgrid_sha256 !== reviewedSha256) throw new Error('reviewed TextGrid checksum mismatch');
  if (Number(attestation.threshold_sec) !== Number(thresholdSec)) throw new Error('attestation threshold mismatch');
  if (attestation.review_status !== 'complete') throw new Error('attestation review_status must be complete');
  if (attestation.reviewer_role !== 'researcher_or_authorized_rater') {
    throw new Error('attestation reviewer_role is not authorized');
  }
  if (!Array.isArray(attestation.reviewed_tiers)
    || attestation.reviewed_tiers.join('|') !== REQUIRED_REVIEWED_TIERS.join('|')) {
    throw new Error('attestation must cover S1/S2/S3/floor/flags tiers');
  }
  if (!Array.isArray(attestation.unresolved_flags) || attestation.unresolved_flags.length !== 0) {
    throw new Error('attestation unresolved_flags must be an empty array');
  }
  if (!Array.isArray(attestation.transition_boundary_decisions)) {
    throw new Error('attestation transition_boundary_decisions must be an array');
  }
}

export function verifyAttestedTransitions(document, decisions) {
  const tierByName = Object.fromEntries(document.tiers.map((tier) => [tier.name, tier]));
  const floorTransfers = floorTransferCandidates(tierByName.floor.intervals);
  if (decisions.length !== floorTransfers.length) {
    throw new Error(`attestation transition count ${decisions.length} does not match reviewed floor transfers ${floorTransfers.length}`);
  }
  const transitions = [];
  for (let index = 0; index < floorTransfers.length; index += 1) {
    const floorTransfer = floorTransfers[index];
    const decision = decisions[index];
    const sequence = Number(decision.sequence);
    if (sequence !== index + 1 || decision.from !== floorTransfer.from || decision.to !== floorTransfer.to) {
      throw new Error(`attested transfer ${index + 1} contradicts reviewed floor sequence`);
    }
    const outgoingOffset = finiteBoundary(decision.outgoing_offset_sec, `transfer ${sequence} outgoing_offset_sec`);
    const incomingOnset = finiteBoundary(decision.incoming_onset_sec, `transfer ${sequence} incoming_onset_sec`);
    const outgoingMatches = phonationEndMatches(tierByName[decision.from].intervals, outgoingOffset);
    const incomingMatches = phonationStartMatches(tierByName[decision.to].intervals, incomingOnset);
    if (outgoingMatches !== 1) throw new Error(`transfer ${sequence} outgoing boundary is missing or ambiguous`);
    if (incomingMatches !== 1) throw new Error(`transfer ${sequence} incoming boundary is missing or ambiguous`);
    if (!close(outgoingOffset, floorTransfer.floor_departure)) {
      throw new Error(`transfer ${sequence} outgoing boundary contradicts floor departure`);
    }
    if (incomingOnset < outgoingOffset - BOUNDARY_TOLERANCE_SECONDS) {
      const incomingInterval = tierByName[decision.to].intervals.find((interval) =>
        phonationIncluded(interval.text) && close(interval.start, incomingOnset));
      if (!incomingInterval || incomingInterval.end < floorTransfer.floor_acquisition - BOUNDARY_TOLERANCE_SECONDS) {
        throw new Error(`transfer ${sequence} negative overlap does not continue through floor acquisition`);
      }
    } else if (!close(incomingOnset, floorTransfer.floor_acquisition)) {
      throw new Error(`transfer ${sequence} non-negative incoming boundary contradicts floor acquisition`);
    }
    const fto = round(incomingOnset - outgoingOffset);
    const transition = {
      sequence,
      from: decision.from,
      to: decision.to,
      floor_departure: round(floorTransfer.floor_departure),
      floor_acquisition: round(floorTransfer.floor_acquisition),
      outgoing_offset: round(outgoingOffset),
      incoming_onset: round(incomingOnset),
      fto,
      point_time: round(fto < 0 ? outgoingOffset : incomingOnset),
    };
    transition.label = `${transition.from}>${transition.to} FTO=${formatSigned(fto)} status=final`;
    transitions.push(transition);
  }
  return { transitions };
}

function validateReviewedStructure(document) {
  return validateSixTierTextGrid({
    ...document,
    tiers: document.tiers.map((tier) => tier.name === 'transitions' ? { ...tier, points: [] } : tier),
  });
}

function assertTier6Resolved(document) {
  const flagsTier = document.tiers.find((tier) => tier.name === 'flags');
  const unresolved = flagsTier.intervals.filter((interval) => String(interval.text || '').trim() !== '');
  if (unresolved.length > 0) throw new Error(`reviewed Tier6 still contains ${unresolved.length} unresolved flag intervals`);
}

function floorTransferCandidates(intervals) {
  const output = [];
  let lastHolder = null;
  let pendingDeparture = null;
  for (const interval of intervals) {
    if (SPEAKERS.includes(interval.text)) {
      const from = pendingDeparture?.from || lastHolder;
      if (from && from !== interval.text) {
        output.push({
          from,
          to: interval.text,
          floor_departure: pendingDeparture?.time ?? interval.start,
          floor_acquisition: interval.start,
        });
      }
      lastHolder = interval.text;
      pendingDeparture = null;
    } else if (interval.text === 'FREE' && lastHolder && !pendingDeparture) {
      pendingDeparture = { from: lastHolder, time: interval.start };
    }
  }
  return output;
}

function phonationEndMatches(intervals, boundary) {
  return intervals.filter((interval) => phonationIncluded(interval.text) && close(interval.end, boundary)).length;
}

function phonationStartMatches(intervals, boundary) {
  return intervals.filter((interval) => phonationIncluded(interval.text) && close(interval.start, boundary)).length;
}

function close(left, right) {
  return Math.abs(Number(left) - Number(right)) <= BOUNDARY_TOLERANCE_SECONDS;
}

function finiteBoundary(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < -EPSILON) throw new Error(`${field} must be a non-negative finite number`);
  return round(number);
}

function requireFile(filePath, label) {
  if (!filePath || !existsSync(filePath)) throw new Error(`${label} is required`);
}

function formatSigned(value) {
  return `${value < 0 ? '-' : '+'}${Math.abs(value).toFixed(3)}`;
}

function deliveryThresholdKey(threshold) {
  return `P${Math.round(Number(threshold) * 100).toString().padStart(3, '0')}`;
}

function safeIdentifier(value, field) {
  const text = String(value ?? '');
  if (!/^[A-Za-z0-9._-]+$/.test(text)) throw new Error(`${field} must be an opaque identifier`);
  return text;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--draft') values.sourceDraftPath = path.resolve(argv[++index]);
    else if (value === '--reviewed-textgrid') values.reviewedTextGridPath = path.resolve(argv[++index]);
    else if (value === '--attestation') values.attestationPath = path.resolve(argv[++index]);
    else if (value === '--threshold') values.threshold = Number(argv[++index]);
    else if (value === '--output') values.outputDir = path.resolve(argv[++index]);
    else if (value === '--recording-id') values.recordingId = argv[++index];
    else if (value === '--task-id') values.taskId = argv[++index];
    else throw new Error(`unknown argument: ${value}`);
  }
  return values;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const output = finalizeReviewedPathB(parseArgs(process.argv.slice(2)));
  process.stdout.write(canonicalJson(output.report));
}
