#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

function parseArgs(argv) {
  const args = {
    html: "",
    outputDir: "",
    sampleId: "elllo_sample",
    title: "ELLLO sample",
    sourceUrl: "",
    audioUrl: "",
    speakers: [],
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--html" && next) {
      args.html = next;
      i += 1;
    } else if (arg === "--output-dir" && next) {
      args.outputDir = next;
      i += 1;
    } else if (arg === "--sample-id" && next) {
      args.sampleId = next;
      i += 1;
    } else if (arg === "--title" && next) {
      args.title = next;
      i += 1;
    } else if (arg === "--source-url" && next) {
      args.sourceUrl = next;
      i += 1;
    } else if (arg === "--audio-url" && next) {
      args.audioUrl = next;
      i += 1;
    } else if (arg === "--speakers" && next) {
      args.speakers = next.split(",").map((speaker) => speaker.trim()).filter(Boolean);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!args.html) throw new Error("--html is required");
  if (!args.outputDir) throw new Error("--output-dir is required");
  if (args.speakers.length === 0) throw new Error("--speakers is required, for example Todd,Simon");
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/extract-elllo-transcript.mjs \\
    --html /tmp/page.html \\
    --output-dir sample-inputs/simple-dialogue/example \\
    --sample-id elllo_425_dinner_plans \\
    --title "Dinner Plans" \\
    --source-url https://elllo.org/... \\
    --audio-url https://...mp3 \\
    --speakers Todd,Simon
`);
}

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&rdquo;/g, '"')
    .replace(/&ldquo;/g, '"');
}

function stripHtml(value) {
  return decodeHtml(
    String(value ?? "")
      .replace(/<br\s*\/?\s*>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function main() {
  const args = parseArgs(process.argv);
  const htmlPath = resolve(args.html);
  const outputDir = resolve(args.outputDir);
  const html = readFileSync(htmlPath, "utf8");
  const allowedSpeakers = new Set(args.speakers);
  const turns = [];
  const paragraphRegex = /<p[^>]*>[\s\S]*?<strong>([^<]+)<\/strong>([\s\S]*?)<\/p>/gi;
  let match;

  while ((match = paragraphRegex.exec(html))) {
    const speaker = stripHtml(match[1]).replace(/:$/, "").trim();
    if (!allowedSpeakers.has(speaker)) continue;
    const text = stripHtml(match[2]).replace(/^:\s*/, "").trim();
    if (!text) continue;
    turns.push({
      turn_id: `turn_${String(turns.length + 1).padStart(3, "0")}`,
      speaker,
      text,
    });
  }

  mkdirSync(outputDir, { recursive: true });
  const payload = {
    sample_id: args.sampleId,
    title: args.title,
    source: "ELLLO",
    source_url: args.sourceUrl,
    audio_url: args.audioUrl,
    note: "Use as a simple human English dialogue for internal pipeline testing.",
    speakers: args.speakers,
    turns,
  };

  writeFileSync(join(outputDir, `${args.sampleId}.turns.json`), `${JSON.stringify(payload, null, 2)}\n`);
  writeFileSync(
    join(outputDir, `${args.sampleId}.transcript.txt`),
    `${turns.map((turn) => `${turn.speaker}: ${turn.text}`).join("\n")}\n`,
  );
  writeFileSync(
    join(outputDir, "SOURCE.md"),
    `# ${args.title}\n\nSource: ${args.sourceUrl}\n\nAudio: ${args.audioUrl}\n\nLocal HTML parsed from: ${basename(htmlPath)}\n\nUse: internal pipeline testing sample.\n`,
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        output_dir: outputDir,
        turn_count: turns.length,
        speakers: [...new Set(turns.map((turn) => turn.speaker))],
      },
      null,
      2,
    ),
  );
}

main();
