const DEFAULT_FRAME_STEP = 0.01;
const SPEAKERS = Object.freeze(['S1', 'S2', 'S3']);
const LABELS = Object.freeze(['s', 'f', 'bc', 'ol', 'op', 'pf', 'tr', 'shs', 'x']);
const ACTIVE_LABELS = new Set(['s', 'f', 'bc', 'ol']);

export function compareSixTierDocuments(predicted, gold, { frameStep = DEFAULT_FRAME_STEP } = {}) {
  const duration = assertCompatibleDocuments(predicted, gold);
  const speakerTiers = SPEAKERS.flatMap((speaker) => [tierByName(predicted, speaker), tierByName(gold, speaker)]);
  const segments = timelineSegments(speakerTiers, duration);
  const predictedLabels = Object.fromEntries(SPEAKERS.map((speaker) => [
    speaker,
    sampleTierSegments(tierByName(predicted, speaker), segments),
  ]));
  const goldLabels = Object.fromEntries(SPEAKERS.map((speaker) => [
    speaker,
    sampleTierSegments(tierByName(gold, speaker), segments),
  ]));

  const confusion = Object.fromEntries(LABELS.map((left) => [
    left,
    Object.fromEntries(LABELS.map((right) => [right, 0])),
  ]));
  let exactLabelSeconds = 0;
  let activeSetExactSeconds = 0;
  let activeSetJaccardWeightedSeconds = 0;
  const room = binaryCounts();
  const bySpeaker = Object.fromEntries(SPEAKERS.map((speaker) => [speaker, binaryCounts()]));

  for (let index = 0; index < segments.length; index += 1) {
    const seconds = segments[index].end - segments[index].start;
    const predictedActiveSet = new Set();
    const goldActiveSet = new Set();
    for (const speaker of SPEAKERS) {
      const predictedLabel = predictedLabels[speaker][index];
      const goldLabel = goldLabels[speaker][index];
      if (predictedLabel === goldLabel) exactLabelSeconds += seconds;
      if (confusion[predictedLabel]?.[goldLabel] != null) confusion[predictedLabel][goldLabel] += seconds;
      const predictedActive = ACTIVE_LABELS.has(predictedLabel);
      const goldActive = ACTIVE_LABELS.has(goldLabel);
      if (predictedActive) predictedActiveSet.add(speaker);
      if (goldActive) goldActiveSet.add(speaker);
      addBinaryCount(bySpeaker[speaker], predictedActive, goldActive, seconds);
    }
    const predictedRoomActive = predictedActiveSet.size > 0;
    const goldRoomActive = goldActiveSet.size > 0;
    addBinaryCount(room, predictedRoomActive, goldRoomActive, seconds);
    if (setsEqual(predictedActiveSet, goldActiveSet)) activeSetExactSeconds += seconds;
    const union = new Set([...predictedActiveSet, ...goldActiveSet]);
    const intersection = [...predictedActiveSet].filter((speaker) => goldActiveSet.has(speaker)).length;
    activeSetJaccardWeightedSeconds += (union.size === 0 ? 1 : intersection / union.size) * seconds;
  }

  const labelMetrics = Object.fromEntries(LABELS.map((label) => {
    const truePositive = confusion[label][label];
    const predictedSeconds = LABELS.reduce((sum, goldLabel) => sum + confusion[label][goldLabel], 0);
    const goldSeconds = LABELS.reduce((sum, predictedLabel) => sum + confusion[predictedLabel][label], 0);
    return [label, metricFromCounts(truePositive, predictedSeconds - truePositive, goldSeconds - truePositive, {
      predicted_seconds: predictedSeconds,
      gold_seconds: goldSeconds,
    })];
  }));
  const observedLabelF1 = LABELS
    .filter((label) => labelMetrics[label].gold_seconds > 0)
    .map((label) => labelMetrics[label].f1);

  const boundaryTolerances = [0.01, 0.02, 0.05, 0.1, 0.25];
  const boundaryBySpeaker = Object.fromEntries(SPEAKERS.map((speaker) => {
    const predictedRuns = activeRuns(tierByName(predicted, speaker), duration);
    const goldRuns = activeRuns(tierByName(gold, speaker), duration);
    return [speaker, boundaryMetrics(predictedRuns, goldRuns, boundaryTolerances, duration)];
  }));
  const boundaryAggregate = aggregateBoundaryMetrics(boundaryBySpeaker, boundaryTolerances);
  const floor = compareFloor(predicted, gold);
  const transitionEvents = compareTransitionEvents(predicted, gold);

  const roomMetric = finishBinaryCounts(room);
  const speakerMetrics = Object.fromEntries(SPEAKERS.map((speaker) => [speaker, finishBinaryCounts(bySpeaker[speaker])]));
  const totalSpeakerSeconds = duration * SPEAKERS.length;
  const outputActivityScore = weightedScore([
    [activeSetExactSeconds / duration, 0.45],
    [roomMetric.f1, 0.35],
    [boundaryAggregate['0.100'].combined.f1, 0.20],
  ]);

  return roundDeep({
    duration_seconds: duration,
    frame_step_seconds: frameStep,
    active_speaker_set: {
      exact_accuracy: activeSetExactSeconds / duration,
      time_weighted_jaccard: activeSetJaccardWeightedSeconds / duration,
    },
    room_activity: roomMetric,
    speaker_activity: speakerMetrics,
    label_agreement: {
      exact_accuracy: exactLabelSeconds / totalSpeakerSeconds,
      macro_f1_observed_gold_labels: mean(observedLabelF1),
      per_label: labelMetrics,
      confusion_seconds: confusion,
    },
    active_boundaries: {
      aggregate: boundaryAggregate,
      by_speaker: boundaryBySpeaker,
    },
    floor,
    transition_events: transitionEvents,
    output_activity_score: outputActivityScore,
  });
}

export function compareVadToGold(vadIntervals, gold, { frameStep = DEFAULT_FRAME_STEP } = {}) {
  const duration = Number(gold.xmax);
  if (!(duration > 0)) throw new Error('Gold TextGrid duration must be positive');
  const predictedRuns = vadIntervals.filter((interval) => interval.text === 'sounding');
  const goldRuns = roomActiveRuns(gold, duration);
  const counts = compareBinaryIntervalSets(predictedRuns, goldRuns, duration);
  const activity = finishBinaryCounts(counts);
  const boundaries = boundaryMetrics(
    predictedRuns,
    goldRuns,
    [0.01, 0.02, 0.05, 0.1, 0.25],
    duration,
  );
  const acousticScore = weightedScore([
    [activity.f1, 0.65],
    [boundaries['0.100'].combined.f1, 0.35],
  ]);
  return roundDeep({
    duration_seconds: duration,
    frame_step_seconds: frameStep,
    activity,
    boundaries,
    acoustic_score: acousticScore,
  });
}

export function candidateSelectionVector(rawMetrics, outputMetrics) {
  return {
    primary_active_set_exact_accuracy: outputMetrics.active_speaker_set.exact_accuracy,
    secondary_output_activity_score: outputMetrics.output_activity_score,
    tertiary_macro_f1: outputMetrics.label_agreement.macro_f1_observed_gold_labels,
    diagnostic_room_vad_score: rawMetrics.acoustic_score,
  };
}

export function deriveFloorHandoffs(document) {
  const speakers = (document?.tiers || [])
    .filter((tier) => tier?.class === 'IntervalTier' && /^S\d+$/.test(String(tier.name)))
    .map((tier) => String(tier.name));
  const floor = tierByName(document, 'floor');
  const handoffs = [];
  let holder = null;
  let turnEnd = null;
  for (const interval of floor.intervals) {
    if (!speakers.includes(interval.text)) {
      if (holder && turnEnd == null) turnEnd = Number(interval.start);
      continue;
    }
    if (!holder) {
      holder = interval.text;
      turnEnd = null;
      continue;
    }
    if (interval.text === holder) {
      turnEnd = null;
      continue;
    }
    const incomingOnset = Number(interval.start);
    const outgoingOffset = turnEnd ?? incomingOnset;
    handoffs.push({
      sequence: handoffs.length + 1,
      from: holder,
      to: interval.text,
      turn_end: outgoingOffset,
      turn_start: incomingOnset,
      raw_gap: incomingOnset - outgoingOffset,
    });
    holder = interval.text;
    turnEnd = null;
  }
  return roundDeep(handoffs);
}

export function compareFloorHandoffs(predicted, gold, { tolerance = 0.1 } = {}) {
  const predictedHandoffs = deriveFloorHandoffs(predicted);
  const goldHandoffs = deriveFloorHandoffs(gold);
  const used = new Set();
  const matches = [];
  for (const predictedHandoff of predictedHandoffs) {
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let index = 0; index < goldHandoffs.length; index += 1) {
      if (used.has(index)) continue;
      const goldHandoff = goldHandoffs[index];
      if (predictedHandoff.from !== goldHandoff.from || predictedHandoff.to !== goldHandoff.to) continue;
      const distance = Math.max(
        Math.abs(predictedHandoff.turn_end - goldHandoff.turn_end),
        Math.abs(predictedHandoff.turn_start - goldHandoff.turn_start),
      );
      if (distance <= tolerance + 1e-9 && distance < bestDistance) {
        bestIndex = index;
        bestDistance = distance;
      }
    }
    if (bestIndex >= 0) {
      used.add(bestIndex);
      matches.push({
        predicted_sequence: predictedHandoff.sequence,
        gold_sequence: goldHandoffs[bestIndex].sequence,
        from: predictedHandoff.from,
        to: predictedHandoff.to,
        maximum_boundary_error_seconds: bestDistance,
      });
    }
  }
  return roundDeep({
    tolerance_seconds: tolerance,
    predicted: predictedHandoffs.length,
    gold: goldHandoffs.length,
    matched: matches.length,
    precision: divide(matches.length, predictedHandoffs.length),
    recall: divide(matches.length, goldHandoffs.length),
    f1: divide(2 * matches.length, predictedHandoffs.length + goldHandoffs.length),
    matches,
  });
}

export function validateTier5Consistency(output, { tolerance = 1e-6 } = {}) {
  const handoffs = deriveFloorHandoffs(output.textgrid_document);
  const points = output.textgrid_document.tiers.find((tier) => tier.name === 'transitions')?.points || [];
  const rows = output.rows?.fto_transitions || [];
  const evidence = output.rows?.transition_evidence || [];
  const errors = [];
  if (points.length !== handoffs.length) errors.push(`Tier5 point count ${points.length} differs from floor handoff count ${handoffs.length}`);
  if (rows.length !== handoffs.length) errors.push(`FTO row count ${rows.length} differs from floor handoff count ${handoffs.length}`);
  if (evidence.length !== handoffs.length) errors.push(`transition evidence count ${evidence.length} differs from floor handoff count ${handoffs.length}`);
  const checked = Math.min(points.length, rows.length, evidence.length, handoffs.length);
  for (let index = 0; index < checked; index += 1) {
    const handoff = handoffs[index];
    const point = points[index];
    const row = rows[index];
    const item = evidence[index];
    const direction = `${handoff.from}>${handoff.to}`;
    if (!String(point.mark).startsWith(`${direction} `)) errors.push(`Tier5 point ${index + 1} direction differs from floor`);
    if (row.from_speaker !== handoff.from || row.to_speaker !== handoff.to) errors.push(`FTO row ${index + 1} direction differs from floor`);
    if (item.from_speaker !== handoff.from || item.to_speaker !== handoff.to) errors.push(`transition evidence ${index + 1} direction differs from floor`);
    for (const [field, actual, expected] of [
      ['outgoing_offset_sec', row.outgoing_offset_sec, handoff.turn_end],
      ['incoming_onset_sec', row.incoming_onset_sec, handoff.turn_start],
      ['turn_end_sec', item.turn_end_sec, handoff.turn_end],
      ['turn_start_sec', item.turn_start_sec, handoff.turn_start],
      ['raw_gap_sec', item.raw_gap_sec, handoff.raw_gap],
      ['point_time', point.number, handoff.turn_start],
    ]) {
      if (Math.abs(Number(actual) - Number(expected)) > tolerance) {
        errors.push(`${field} ${index + 1} differs from generated floor`);
      }
    }
  }
  return {
    pass: errors.length === 0,
    floor_handoff_count: handoffs.length,
    tier5_point_count: points.length,
    fto_row_count: rows.length,
    transition_evidence_count: evidence.length,
    direction_checked_count: checked,
    errors,
  };
}

function assertCompatibleDocuments(predicted, gold) {
  const predictedDuration = Number(predicted?.xmax);
  const goldDuration = Number(gold?.xmax);
  if (!(predictedDuration > 0) || !(goldDuration > 0) || Math.abs(predictedDuration - goldDuration) > 1e-6) {
    throw new Error('Predicted and gold TextGrids must share the same positive duration');
  }
  for (const speaker of SPEAKERS) {
    tierByName(predicted, speaker);
    tierByName(gold, speaker);
  }
  return goldDuration;
}

function tierByName(document, name) {
  const tier = document?.tiers?.find((item) => item.name === name);
  if (!tier || !Array.isArray(tier.intervals)) throw new Error(`Missing IntervalTier ${name}`);
  return tier;
}

function timelineSegments(tiers, duration) {
  const boundaries = new Set([0, duration]);
  for (const tier of tiers) {
    for (const interval of tier.intervals) {
      boundaries.add(Number(interval.start));
      boundaries.add(Number(interval.end));
    }
  }
  const ordered = [...boundaries].sort((left, right) => left - right);
  return ordered.slice(0, -1).map((start, index) => ({ start, end: ordered[index + 1] }))
    .filter((segment) => segment.end > segment.start + 1e-12);
}

function sampleTierSegments(tier, segments) {
  const labels = [];
  let intervalIndex = 0;
  for (const segment of segments) {
    const midpoint = segment.start + (segment.end - segment.start) / 2;
    while (intervalIndex + 1 < tier.intervals.length && midpoint >= tier.intervals[intervalIndex].end - 1e-9) {
      intervalIndex += 1;
    }
    labels.push(String(tier.intervals[intervalIndex]?.text ?? ''));
  }
  return labels;
}

function activeRuns(tier, duration) {
  return mergeIntervals(tier.intervals
    .filter((interval) => ACTIVE_LABELS.has(interval.text))
    .map((interval) => ({ start: interval.start, end: interval.end })), duration);
}

function roomActiveRuns(document, duration) {
  return mergeIntervals(SPEAKERS.flatMap((speaker) => activeRuns(tierByName(document, speaker), duration)), duration);
}

function mergeIntervals(intervals, duration) {
  const output = [];
  for (const interval of [...intervals]
    .map((item) => ({ start: Math.max(0, Number(item.start)), end: Math.min(duration, Number(item.end)) }))
    .filter((item) => item.end > item.start)
    .sort((left, right) => left.start - right.start || left.end - right.end)) {
    const previous = output.at(-1);
    if (previous && interval.start <= previous.end + 1e-9) previous.end = Math.max(previous.end, interval.end);
    else output.push({ ...interval });
  }
  return output;
}

function binaryCounts() {
  return { true_positive_seconds: 0, false_positive_seconds: 0, false_negative_seconds: 0, true_negative_seconds: 0 };
}

function addBinaryCount(counts, predicted, gold, seconds) {
  if (predicted && gold) counts.true_positive_seconds += seconds;
  else if (predicted) counts.false_positive_seconds += seconds;
  else if (gold) counts.false_negative_seconds += seconds;
  else counts.true_negative_seconds += seconds;
}

function finishBinaryCounts(counts) {
  const result = metricFromCounts(
    counts.true_positive_seconds,
    counts.false_positive_seconds,
    counts.false_negative_seconds,
    counts,
  );
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return { ...result, accuracy: total ? (counts.true_positive_seconds + counts.true_negative_seconds) / total : 0 };
}

function compareBinaryIntervalSets(predictedRuns, goldRuns, duration) {
  const tiers = [
    { intervals: binaryCoverage(predictedRuns, duration) },
    { intervals: binaryCoverage(goldRuns, duration) },
  ];
  const segments = timelineSegments(tiers, duration);
  const predicted = sampleTierSegments(tiers[0], segments);
  const gold = sampleTierSegments(tiers[1], segments);
  const counts = binaryCounts();
  for (let index = 0; index < segments.length; index += 1) {
    addBinaryCount(
      counts,
      predicted[index] === 'active',
      gold[index] === 'active',
      segments[index].end - segments[index].start,
    );
  }
  return counts;
}

function binaryCoverage(runs, duration) {
  const intervals = [];
  let cursor = 0;
  for (const run of mergeIntervals(runs, duration)) {
    if (run.start > cursor + 1e-12) intervals.push({ start: cursor, end: run.start, text: 'inactive' });
    intervals.push({ start: run.start, end: run.end, text: 'active' });
    cursor = run.end;
  }
  if (cursor < duration - 1e-12) intervals.push({ start: cursor, end: duration, text: 'inactive' });
  return intervals.length ? intervals : [{ start: 0, end: duration, text: 'inactive' }];
}

function metricFromCounts(truePositive, falsePositive, falseNegative, extra = {}) {
  const precision = divide(truePositive, truePositive + falsePositive);
  const recall = divide(truePositive, truePositive + falseNegative);
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { ...extra, true_positive_seconds: truePositive, false_positive_seconds: falsePositive, false_negative_seconds: falseNegative, precision, recall, f1 };
}

function boundaryMetrics(predictedRuns, goldRuns, tolerances, duration) {
  const predictedOnsets = predictedRuns.map((run) => run.start).filter((value) => value > 1e-9 && value < duration - 1e-9);
  const predictedOffsets = predictedRuns.map((run) => run.end).filter((value) => value > 1e-9 && value < duration - 1e-9);
  const goldOnsets = goldRuns.map((run) => run.start).filter((value) => value > 1e-9 && value < duration - 1e-9);
  const goldOffsets = goldRuns.map((run) => run.end).filter((value) => value > 1e-9 && value < duration - 1e-9);
  return Object.fromEntries(tolerances.map((tolerance) => {
    const onset = matchBoundaries(predictedOnsets, goldOnsets, tolerance);
    const offset = matchBoundaries(predictedOffsets, goldOffsets, tolerance);
    return [tolerance.toFixed(3), { onset, offset, combined: combineEventMetrics(onset, offset) }];
  }));
}

function aggregateBoundaryMetrics(bySpeaker, tolerances) {
  return Object.fromEntries(tolerances.map((tolerance) => {
    const key = tolerance.toFixed(3);
    const onset = combineEventMetrics(...SPEAKERS.map((speaker) => bySpeaker[speaker][key].onset));
    const offset = combineEventMetrics(...SPEAKERS.map((speaker) => bySpeaker[speaker][key].offset));
    return [key, { onset, offset, combined: combineEventMetrics(onset, offset) }];
  }));
}

function matchBoundaries(predicted, gold, tolerance) {
  let predictedIndex = 0;
  let goldIndex = 0;
  let matched = 0;
  const errors = [];
  while (predictedIndex < predicted.length && goldIndex < gold.length) {
    const difference = predicted[predictedIndex] - gold[goldIndex];
    if (Math.abs(difference) <= tolerance + 1e-9) {
      matched += 1;
      errors.push(Math.abs(difference));
      predictedIndex += 1;
      goldIndex += 1;
    } else if (difference < 0) predictedIndex += 1;
    else goldIndex += 1;
  }
  return eventMetric(matched, predicted.length, gold.length, errors);
}

function eventMetric(matched, predicted, gold, errors = []) {
  const precision = divide(matched, predicted);
  const recall = divide(matched, gold);
  return {
    matched,
    predicted,
    gold,
    precision,
    recall,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    median_absolute_error_seconds: median(errors),
  };
}

function combineEventMetrics(...metrics) {
  const matched = metrics.reduce((sum, metric) => sum + metric.matched, 0);
  const predicted = metrics.reduce((sum, metric) => sum + metric.predicted, 0);
  const gold = metrics.reduce((sum, metric) => sum + metric.gold, 0);
  return eventMetric(matched, predicted, gold);
}

function compareFloor(predicted, gold) {
  const predictedTier = tierByName(predicted, 'floor');
  const goldTier = tierByName(gold, 'floor');
  const segments = timelineSegments([predictedTier, goldTier], Number(gold.xmax));
  const predictedLabels = sampleTierSegments(predictedTier, segments);
  const goldLabels = sampleTierSegments(goldTier, segments);
  let exact = 0;
  for (let index = 0; index < segments.length; index += 1) {
    if (predictedLabels[index] === goldLabels[index]) exact += segments[index].end - segments[index].start;
  }
  const predictedBoundaries = predictedTier.intervals.slice(0, -1).map((interval) => interval.end);
  const goldBoundaries = goldTier.intervals.slice(0, -1).map((interval) => interval.end);
  return {
    exact_accuracy: exact / Number(gold.xmax),
    mismatch_seconds: Number(gold.xmax) - exact,
    boundaries: Object.fromEntries([0.01, 0.05, 0.1, 0.25].map((tolerance) => [
      tolerance.toFixed(3),
      matchBoundaries(predictedBoundaries, goldBoundaries, tolerance),
    ])),
  };
}

function compareTransitionEvents(predicted, gold) {
  const collect = (document) => {
    const unique = new Map();
    for (const speaker of SPEAKERS) {
      for (const interval of tierByName(document, speaker).intervals.filter((item) => item.text === 'tr')) {
        unique.set(`${interval.start.toFixed(6)}|${interval.end.toFixed(6)}`, { start: interval.start, end: interval.end });
      }
    }
    return [...unique.values()].sort((left, right) => left.start - right.start || left.end - right.end);
  };
  const predictedEvents = collect(predicted);
  const goldEvents = collect(gold);
  const used = new Set();
  let matched = 0;
  for (const predictedEvent of predictedEvents) {
    let bestIndex = -1;
    let bestOverlap = 0;
    for (let index = 0; index < goldEvents.length; index += 1) {
      if (used.has(index)) continue;
      const overlap = Math.max(0, Math.min(predictedEvent.end, goldEvents[index].end) - Math.max(predictedEvent.start, goldEvents[index].start));
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0) {
      matched += 1;
      used.add(bestIndex);
    }
  }
  return eventMetric(matched, predictedEvents.length, goldEvents.length);
}

function setsEqual(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function weightedScore(items) {
  return items.reduce((sum, [value, weight]) => sum + Number(value || 0) * weight, 0);
}

function divide(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
}

function roundDeep(value) {
  if (Array.isArray(value)) return value.map(roundDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, roundDeep(item)]));
  }
  return typeof value === 'number' ? round(value) : value;
}
