import { EPSILON, SPEAKERS, round } from '../core/contracts.mjs';

const ACTIVE_LABELS = new Set(['s', 'f', 'bc', 'ol']);

export function composeActivityTopologyWithSemantics(topology, semantic, userOptions = {}) {
  validateDocuments(topology, semantic);
  const duration = Number(semantic.xmax);
  const preservedEvidence = normalizePreservedEvidence(
    userOptions.preserveSemanticActivityIntervals || [],
    duration,
  );
  const floorTier = tier(semantic, 'floor');
  const mismatches = [];
  const preservations = [];
  const speakerTiers = SPEAKERS.map((speaker) => {
    const topologyTier = tier(topology, speaker);
    const semanticTier = tier(semantic, speaker);
    const speakerEvidence = preservedEvidence.filter((item) => item.speaker === speaker);
    const boundaries = unionBoundaries([
      topologyTier,
      semanticTier,
      floorTier,
      { intervals: speakerEvidence },
    ], duration);
    const intervals = [];
    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const start = boundaries[index];
      const end = boundaries[index + 1];
      if (!(end > start + EPSILON)) continue;
      const time = start + (end - start) / 2;
      const topologyLabel = labelAt(topologyTier, time);
      const semanticLabel = labelAt(semanticTier, time);
      const floorLabel = labelAt(floorTier, time);
      const topologyActive = ACTIVE_LABELS.has(topologyLabel);
      const semanticActive = ACTIVE_LABELS.has(semanticLabel);
      const preservationEvidence = speakerEvidence
        .find((item) => item.start <= time + EPSILON && item.end > time + EPSILON);
      const preserveSemanticActivity = semanticActive && Boolean(preservationEvidence);
      let text;
      if (semanticLabel === 'x') text = 'x';
      else if (preserveSemanticActivity) text = preservationEvidence.label || semanticLabel;
      else if (topologyActive) text = semanticActive ? semanticLabel : 's';
      else text = semanticActive ? inactiveLabel(speaker, floorLabel) : semanticLabel;
      appendInterval(intervals, { start, end, text });
      if (preserveSemanticActivity && !topologyActive) {
        preservations.push({
          start: round(start, 6),
          end: round(end, 6),
          speaker,
          code: 'qualified_overlap_semantic_activity_preserved',
        });
      }
      if (topologyActive !== semanticActive && semanticLabel !== 'x') {
        mismatches.push({
          start: round(start, 6), end: round(end, 6), speaker,
          code: topologyActive ? 'acoustic_active_semantic_inactive' : 'acoustic_inactive_semantic_active',
        });
      }
    }
    return { class: 'IntervalTier', name: speaker, xmin: 0, xmax: duration, intervals };
  });
  const overlapRepairs = repairOneSidedOverlap(speakerTiers, floorTier, duration);
  const flagsTier = composeFlags(
    tier(semantic, 'flags'),
    [...mismatches, ...preservations, ...overlapRepairs],
    duration,
  );
  const document = {
    xmin: 0,
    xmax: duration,
    tiers: [
      ...speakerTiers,
      structuredClone(floorTier),
      structuredClone(tier(semantic, 'transitions')),
      flagsTier,
    ],
  };
  return {
    document,
    mismatches,
    preservations,
    stats: {
      mismatch_interval_count: mismatches.length,
      mismatch_seconds: round(mismatches.reduce((sum, item) => sum + item.end - item.start, 0), 6),
      by_code: Object.fromEntries([...new Set(mismatches.map((item) => item.code))].sort().map((code) => [code, {
        count: mismatches.filter((item) => item.code === code).length,
        seconds: round(mismatches.filter((item) => item.code === code)
          .reduce((sum, item) => sum + item.end - item.start, 0), 6),
      }])),
      preserved_interval_count: preservations.length,
      preserved_seconds: round(preservations.reduce((sum, item) => sum + item.end - item.start, 0), 6),
      one_sided_overlap_repair_count: overlapRepairs.length,
      one_sided_overlap_repair_seconds: round(
        overlapRepairs.reduce((sum, item) => sum + item.end - item.start, 0),
        6,
      ),
    },
    contract_version: 'activity-semantic-composer-v2',
    runtime_gold_access: false,
    floor_source: 'semantic_lane_unchanged',
    transitions_source: 'semantic_lane_unchanged',
  };
}

function repairOneSidedOverlap(speakerTiers, floorTier, duration) {
  const boundaries = unionBoundaries([...speakerTiers, floorTier], duration);
  const repairs = [];
  const rebuilt = Object.fromEntries(speakerTiers.map((item) => [item.name, []]));
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    if (!(end > start + EPSILON)) continue;
    const time = start + (end - start) / 2;
    const labels = Object.fromEntries(speakerTiers.map((item) => [item.name, labelAt(item, time)]));
    const overlapSpeakers = SPEAKERS.filter((speaker) => labels[speaker] === 'ol');
    const floorLabel = labelAt(floorTier, time);
    for (const speaker of SPEAKERS) {
      let text = labels[speaker];
      if (overlapSpeakers.length === 1 && overlapSpeakers[0] === speaker) {
        text = floorLabel === speaker ? 's' : 'bc';
        repairs.push({
          start: round(start, 6),
          end: round(end, 6),
          speaker,
          code: 'one_sided_overlap_downgraded',
        });
      }
      appendInterval(rebuilt[speaker], { start, end, text });
    }
  }
  for (const item of speakerTiers) item.intervals = rebuilt[item.name];
  return repairs;
}

function normalizePreservedEvidence(items, duration) {
  return items.map((item) => ({
    speaker: String(item.speaker),
    start: Math.max(0, Number(item.start)),
    end: Math.min(duration, Number(item.end)),
    evidence_id: String(item.evidence_id || item.event_id || ''),
    label: String(item.label || ''),
  })).filter((item) => SPEAKERS.includes(item.speaker)
    && Number.isFinite(item.start) && Number.isFinite(item.end)
    && item.end > item.start + EPSILON)
    .sort((left, right) => left.start - right.start || left.end - right.end
      || left.speaker.localeCompare(right.speaker));
}

function inactiveLabel(speaker, floorLabel) {
  if (floorLabel === speaker) return 'op';
  if (SPEAKERS.includes(floorLabel)) return 'pf';
  return floorLabel === 'tr' ? 'tr' : 'shs';
}

function composeFlags(baseTier, mismatches, duration) {
  const boundaries = new Set([0, duration]);
  for (const interval of baseTier.intervals) {
    boundaries.add(Number(interval.start));
    boundaries.add(Number(interval.end));
  }
  for (const item of mismatches) {
    boundaries.add(Number(item.start));
    boundaries.add(Number(item.end));
  }
  const ordered = [...boundaries].sort((left, right) => left - right);
  const intervals = [];
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const start = ordered[index];
    const end = ordered[index + 1];
    if (!(end > start + EPSILON)) continue;
    const time = start + (end - start) / 2;
    const base = labelAt(baseTier, time).split('|').map((item) => item.trim()).filter(Boolean);
    const extra = mismatches.filter((item) => item.start <= time + EPSILON && item.end > time + EPSILON)
      .map((item) => `${item.code}:${item.speaker}`);
    appendInterval(intervals, { start, end, text: [...new Set([...base, ...extra])].sort().join('|') });
  }
  return { class: 'IntervalTier', name: 'flags', xmin: 0, xmax: duration, intervals };
}

function unionBoundaries(tiers, duration) {
  const values = new Set([0, duration]);
  for (const item of tiers) for (const interval of item.intervals) {
    values.add(Number(interval.start));
    values.add(Number(interval.end));
  }
  return [...values].sort((left, right) => left - right);
}

function labelAt(item, time) {
  return String(item.intervals.find((interval) => interval.start <= time + EPSILON && interval.end > time + EPSILON)?.text ?? '');
}

function appendInterval(intervals, interval) {
  const normalized = { start: round(interval.start, 6), end: round(interval.end, 6), text: String(interval.text) };
  const previous = intervals.at(-1);
  if (previous && previous.text === normalized.text && Math.abs(previous.end - normalized.start) <= EPSILON) {
    previous.end = normalized.end;
  } else intervals.push(normalized);
}

function tier(document, name) {
  const item = document.tiers.find((candidate) => candidate.name === name);
  if (!item) throw new Error(`missing tier ${name}`);
  return item;
}

function validateDocuments(topology, semantic) {
  if (!(Number(topology?.xmax) > 0) || Math.abs(Number(topology.xmax) - Number(semantic?.xmax)) > 1e-6) {
    throw new Error('topology and semantic documents must share a positive duration');
  }
  for (const name of [...SPEAKERS, 'floor', 'transitions', 'flags']) {
    tier(topology, name);
    tier(semantic, name);
  }
}
