#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseTextGrid, round } from "./textgrid-utils.mjs";

const DEFAULT_DRAFT =
  "sample-inputs/simple-dialogue/elllo-425-dinner-plans/elllo_425_dinner_plans.assemblyai.6tier.TextGrid";
const DEFAULT_TURNS =
  "sample-inputs/simple-dialogue/elllo-425-dinner-plans/elllo_425_dinner_plans.turns.json";
const DEFAULT_OUTPUT =
  "sample-inputs/simple-dialogue/elllo-425-dinner-plans/elllo_425_dinner_plans.reviewed.simulated.TextGrid";

const reviewedTurnMap = [
  { start: 0.53, end: 6.17, speaker: "Todd", turnIndexes: [0] },
  { start: 7.02, end: 12.1, speaker: "Simon", turnIndexes: [1] },
  { start: 12.1, end: 28.73, speaker: "Todd", turnIndexes: [2] },
  { start: 29.45, end: 32.049, speaker: "Simon", turnIndexes: [3] },
  { start: 32.169, end: 52.63, speaker: "Todd", turnIndexes: [4] },
  { start: 52.72, end: 64.97, speaker: "Simon", turnIndexes: [5] },
  { start: 65.48, end: 83.96, speaker: "Todd", turnIndexes: [6] },
  { start: 84.37, end: 88.06, speaker: "Simon", turnIndexes: [7] },
  { start: 88.17, end: 90.4, speaker: "Todd", turnIndexes: [8] },
  { start: 90.869, end: 93.13, speaker: "Simon", turnIndexes: [9] },
  { start: 93.25, end: 100.49, speaker: "Todd", turnIndexes: [10] },
  { start: 100.49, end: 101.71, speaker: "Simon", turnIndexes: [11] },
  { start: 101.71, end: 123.32, speaker: "Todd", turnIndexes: [12] },
  { start: 123.32, end: 125.15, speaker: "Simon", turnIndexes: [13] },
  { start: 125.16, end: 126.52, speaker: "Todd", turnIndexes: [14] },
  { start: 127.02, end: 128.69, speaker: "Simon", turnIndexes: [15] },
  { start: 128.76, end: 129.94, speaker: "Todd", turnIndexes: [16] },
  { start: 129.94, end: 130.42, speaker: "Simon", turnIndexes: [17] },
];

function parseArgs(argv) {
  const args = {
    draft: DEFAULT_DRAFT,
    turns: DEFAULT_TURNS,
    output: DEFAULT_OUTPUT,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--draft" && next) {
      args.draft = next;
      i += 1;
    } else if (arg === "--turns" && next) {
      args.turns = next;
      i += 1;
    } else if (arg === "--output" && next) {
      args.output = next;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/simulate-elllo-425-reviewed-textgrid.mjs [options]

Options:
  --draft <path>   Draft 6-tier TextGrid. Default: ${DEFAULT_DRAFT}
  --turns <path>   ELLLO official turns JSON. Default: ${DEFAULT_TURNS}
  --output <path>  Reviewed simulated TextGrid. Default: ${DEFAULT_OUTPUT}
`);
}

function escapeTextGridString(value) {
  return String(value ?? "").replaceAll('"', '""');
}

function textForTurn(turns, turnIndexes) {
  return turnIndexes.map((index) => turns[index]?.text ?? "").join(" ").replace(/\s+/g, " ").trim();
}

function textGridXmax(tiers) {
  return round(
    Math.max(
      ...tiers.flatMap((tier) => tier.intervals.flatMap((interval) => [interval.start, interval.end])),
      0,
    ),
    6,
  );
}

function fullCoverageIntervals(turns, xmax, textSelector) {
  const intervals = [];
  let cursor = 0;

  for (const turn of turns) {
    const start = round(turn.start, 6);
    const end = round(turn.end, 6);
    if (start > cursor) intervals.push({ start: cursor, end: start, text: "" });
    intervals.push({ start, end, text: textSelector(turn) });
    cursor = end;
  }

  if (cursor < xmax) intervals.push({ start: cursor, end: xmax, text: "" });
  return intervals.filter((interval) => interval.end > interval.start);
}

function serializeTextGrid(tiers, xmax) {
  const lines = [
    'File type = "ooTextFile"',
    'Object class = "TextGrid"',
    "",
    "xmin = 0",
    `xmax = ${xmax}`,
    "tiers? <exists>",
    `size = ${tiers.length}`,
    "item []:",
  ];

  tiers.forEach((tier, tierIndex) => {
    lines.push(`    item [${tierIndex + 1}]:`);
    lines.push('        class = "IntervalTier"');
    lines.push(`        name = "${escapeTextGridString(tier.name)}"`);
    lines.push("        xmin = 0");
    lines.push(`        xmax = ${xmax}`);
    lines.push(`        intervals: size = ${tier.intervals.length}`);
    tier.intervals.forEach((interval, intervalIndex) => {
      lines.push(`        intervals [${intervalIndex + 1}]:`);
      lines.push(`            xmin = ${round(interval.start, 6)}`);
      lines.push(`            xmax = ${round(interval.end, 6)}`);
      lines.push(`            text = "${escapeTextGridString(interval.text)}"`);
    });
  });

  return `${lines.join("\n")}\n`;
}

function clearTierText(tier) {
  return {
    ...tier,
    intervals: tier.intervals.map((interval) => ({ ...interval, text: "" })),
  };
}

function main() {
  const args = parseArgs(process.argv);
  const draftPath = resolve(args.draft);
  const turnsPath = resolve(args.turns);
  const outputPath = resolve(args.output);

  if (!existsSync(draftPath)) throw new Error(`Draft TextGrid does not exist: ${draftPath}`);
  if (!existsSync(turnsPath)) throw new Error(`Turns JSON does not exist: ${turnsPath}`);

  const draftTiers = parseTextGrid(readFileSync(draftPath, "utf8"));
  const turnsPayload = JSON.parse(readFileSync(turnsPath, "utf8"));
  const officialTurns = Array.isArray(turnsPayload.turns) ? turnsPayload.turns : [];
  const xmax = textGridXmax(draftTiers);
  const reviewedTurns = reviewedTurnMap.map((turn) => ({
    ...turn,
    text: textForTurn(officialTurns, turn.turnIndexes),
  }));

  const speakerTier = {
    name: "speaker",
    intervals: fullCoverageIntervals(reviewedTurns, xmax, (turn) => turn.speaker),
  };
  const transcriptTier = {
    name: "transcript",
    intervals: fullCoverageIntervals(reviewedTurns, xmax, (turn) => turn.text),
  };
  const reviewTier = {
    name: "review_status",
    intervals: fullCoverageIntervals(
      reviewedTurns,
      xmax,
      () => "fixed: simulated review from ELLLO source transcript; researcher must verify in Praat",
    ),
  };

  const outputTiers = draftTiers.map((tier) => {
    if (tier.name === "sounding_silence_review_status") return clearTierText(tier);
    if (tier.name === "speaker") return speakerTier;
    if (tier.name === "transcript") return transcriptTier;
    if (tier.name === "review_status") return reviewTier;
    return tier;
  });

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serializeTextGrid(outputTiers, xmax));

  const logPath = outputPath.replace(/\.TextGrid$/i, ".review-log.json");
  writeFileSync(
    logPath,
    `${JSON.stringify(
      {
        stage: "simulated-human-review",
        created_at: new Date().toISOString(),
        source_draft_textgrid: draftPath,
        source_turns_json: turnsPath,
        output_textgrid: outputPath,
        note:
          "This is a simulated reviewed TextGrid for pipeline testing. It uses ELLLO source transcript and ASR-derived approximate turn boundaries; it is not a real researcher-verified TextGrid.",
        changes: {
          speaker_labels: "speaker_A/speaker_B replaced with Todd/Simon",
          transcript: "AssemblyAI transcript replaced with ELLLO source transcript",
          sounding_silence_review_status: "cleared to simulate accepted acoustic review using Tier1 as primary reference",
          review_status: "all reviewed turn intervals marked fixed: simulated review",
        },
        reviewed_turn_count: reviewedTurns.length,
        reviewed_turns: reviewedTurns,
      },
      null,
      2,
    )}\n`,
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        output_textgrid: outputPath,
        review_log: logPath,
        reviewed_turn_count: reviewedTurns.length,
        tier_count: outputTiers.length,
      },
      null,
      2,
    ),
  );
}

main();
