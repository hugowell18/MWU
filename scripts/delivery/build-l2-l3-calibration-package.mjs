#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULTS = {
  l2Run: "outputs/layer2-validation/Multilogue04_C_Level30_D1G4-L2-calibration-draft-v5",
  l3Run: "outputs/layer3-validation/Multilogue04_C_Level30_D1G4-L3-calibration-draft-v6",
  guide: "html/Layer2_Layer3_Calibration_Readiness.html",
  outputDir: "/Users/nedved/Downloads/Multilogue04_Layer2_Layer3_Calibration_Draft_1_of_10",
};

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  const fields = new Map([
    ["--l2-run", "l2Run"],
    ["--l3-run", "l3Run"],
    ["--guide", "guide"],
    ["--output-dir", "outputDir"],
  ]);
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (fields.has(arg) && argv[index + 1]) {
      args[fields.get(arg)] = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  return args;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function listFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push(path);
    }
  };
  visit(root);
  return files.sort();
}

function copyRequired(source, target) {
  if (!existsSync(source)) throw new Error(`Missing package source: ${source}`);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

function writeText(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

const args = parseArgs(process.argv);
const l2Run = resolve(args.l2Run);
const l3Run = resolve(args.l3Run);
const guide = resolve(args.guide);
const outputDir = resolve(args.outputDir);
const zipPath = `${outputDir}.zip`;

if (existsSync(outputDir) || existsSync(zipPath)) {
  throw new Error(`Refusing to overwrite an existing delivery: ${outputDir}`);
}

const mappings = [
  [guide, join(outputDir, "Multilogue04_L2_L3_Calibration_Guide.html")],

  [join(l2Run, "outputs/transcript/S1_RAW-TIMING.txt"), join(outputDir, "01_Layer2_Verified_Core/S1_RAW-TIMING.txt")],
  [join(l2Run, "outputs/transcript/S2_RAW-TIMING.txt"), join(outputDir, "01_Layer2_Verified_Core/S2_RAW-TIMING.txt")],
  [join(l2Run, "outputs/transcript/S3_RAW-TIMING.txt"), join(outputDir, "01_Layer2_Verified_Core/S3_RAW-TIMING.txt")],
  [join(l2Run, "outputs/transcript/S1_TIDY-PHRASE.txt"), join(outputDir, "01_Layer2_Verified_Core/S1_TIDY-PHRASE.txt")],
  [join(l2Run, "outputs/transcript/S2_TIDY-PHRASE.txt"), join(outputDir, "01_Layer2_Verified_Core/S2_TIDY-PHRASE.txt")],
  [join(l2Run, "outputs/transcript/S3_TIDY-PHRASE.txt"), join(outputDir, "01_Layer2_Verified_Core/S3_TIDY-PHRASE.txt")],
  [join(l2Run, "inputs/transcript_turns.csv"), join(outputDir, "01_Layer2_Verified_Core/transcript_turns.csv")],
  [join(l2Run, "outputs/transcript/transformation_log.json"), join(outputDir, "01_Layer2_Verified_Core/transformation_log.json")],
  [join(l2Run, "outputs/acoustic/p025_qualifying_own_pauses.csv"), join(outputDir, "01_Layer2_Verified_Core/p025_qualifying_own_pauses.csv")],
  [join(l2Run, "outputs/acoustic/transition_fto_evidence.csv"), join(outputDir, "01_Layer2_Verified_Core/transition_fto_evidence.csv")],

  [join(l2Run, "outputs/features/as_unit_candidates.csv"), join(outputDir, "02_Layer2_Provisional_Samples/as_unit_candidates.csv")],
  [join(l2Run, "outputs/features/pause_location_candidates.csv"), join(outputDir, "02_Layer2_Provisional_Samples/pause_location_candidates.csv")],
  [join(l2Run, "outputs/features/mwu_occurrences.csv"), join(outputDir, "02_Layer2_Provisional_Samples/mwu_occurrences.csv")],
  [join(l2Run, "outputs/features/repair_features.csv"), join(outputDir, "02_Layer2_Provisional_Samples/repair_features.csv")],
  [join(l2Run, "outputs/features/speaker_fluency_features.csv"), join(outputDir, "02_Layer2_Provisional_Samples/speaker_fluency_features.csv")],
  [join(l2Run, "outputs/features/lexical_features.csv"), join(outputDir, "02_Layer2_Provisional_Samples/lexical_features.csv")],

  [join(l3Run, "outputs/research_export.provisional.xlsx"), join(outputDir, "03_Layer3_Calibration/research_export.calibration_draft.xlsx")],
  [join(l3Run, "outputs/research_matrix.provisional.csv"), join(outputDir, "03_Layer3_Calibration/research_matrix.calibration_draft.csv")],
  [join(l3Run, "outputs/field_provenance.csv"), join(outputDir, "03_Layer3_Calibration/field_provenance.csv")],
  [join(l3Run, "outputs/transition_fto.provisional.csv"), join(outputDir, "03_Layer3_Calibration/transition_fto.calibration_draft.csv")],
  [join(l3Run, "outputs/transition_fto_codebook.csv"), join(outputDir, "03_Layer3_Calibration/transition_fto_codebook.csv")],
  [join(l3Run, "inputs/provisional_codebook.csv"), join(outputDir, "03_Layer3_Calibration/calibration_codebook.csv")],

  [join(l2Run, "reports/validation_report.json"), join(outputDir, "04_Validation/L2_validation_report.json")],
  [join(l2Run, "reports/validation_report.md"), join(outputDir, "04_Validation/L2_validation_report.md")],
  [join(l3Run, "reports/validation_report.json"), join(outputDir, "04_Validation/L3_validation_report.json")],
  [join(l3Run, "reports/validation_report.md"), join(outputDir, "04_Validation/L3_validation_report.md")],
  [join(l3Run, "validation/gold_derived_comparison.csv"), join(outputDir, "04_Validation/gold_derived_comparison.csv")],
  [join(l3Run, "validation/upstream_unresolved_items.csv"), join(outputDir, "04_Validation/unresolved_items.csv")],
];

for (const [source, target] of mappings) copyRequired(source, target);

const l2Report = JSON.parse(readFileSync(join(l2Run, "reports/validation_report.json"), "utf8"));
const l3Report = JSON.parse(readFileSync(join(l3Run, "reports/validation_report.json"), "utf8"));
const summary = {
  package_status: "engineering_calibration_draft_1_of_10",
  research_claim_ready: false,
  transcript_words: l2Report.analysis_word_count,
  timing_coverage_ratio: l2Report.analysis_timing.mfa_support_ratio,
  mfa_supported_words: l2Report.analysis_timing.mfa_supported_word_count,
  assemblyai_fallback_words: l2Report.analysis_timing.assemblyai_fallback_word_count,
  alignment_review_gate: l2Report.alignment_review_gate,
  researcher_labelled_own_pauses: l2Report.all_own_pause_count,
  p025_qualifying_own_pauses: l2Report.pause_count,
  transition_evidence: l2Report.transition_evidence,
  layer3_gold_checks: l3Report.gold_comparison_summary,
  layer3_matrix: l3Report.matrix,
};
writeText(join(outputDir, "04_Validation/calibration_summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

writeText(
  join(outputDir, "README.txt"),
  `MULTILOGUE04 LAYER 2 / LAYER 3 ENGINEERING CALIBRATION DRAFT\n\n` +
    `Scope: 1 of 10 recordings\n` +
    `Research release ready: No\n\n` +
    `This package demonstrates the engineering handoff from a researcher-corrected P025 TextGrid and verified transcript into Layer 2 artifacts and a Layer 3 calibration workbook.\n\n` +
    `01_Layer2_Verified_Core contains reviewed-input carry-through and generated timing drafts.\n` +
    `02_Layer2_Provisional_Samples contains definition-dependent previews that are not accepted research results.\n` +
    `03_Layer3_Calibration contains the blank-safe matrix, workbook, codebooks and provenance.\n` +
    `04_Validation contains technical reports, Gold-derived comparisons and unresolved items.\n\n` +
    `Key boundaries:\n` +
    `- 97.16% is timing coverage, not boundary accuracy.\n` +
    `- 636 researcher-labelled own pauses exist; 244 meet P025.\n` +
    `- 22 transition points are retained; 4 Path B overlap offsets remain unmeasured.\n` +
    `- 15/15 checks cover only independently recalculated P025 acoustic fields.\n` +
    `- Definition-dependent linguistic values remain blank in the main matrix.\n\n` +
    `No audio, credentials or internal MFA work files are included.\n`,
);

const packageFiles = listFiles(outputDir).filter((path) => basename(path) !== "package_manifest.json");
const manifest = {
  schema_version: "mwu-l2-l3-calibration-delivery-v1",
  generated_at: new Date().toISOString(),
  package_name: basename(outputDir),
  source_runs: {
    layer2: l2Report.run_id,
    layer3: l3Report.run_id,
  },
  confidential_research_data: true,
  contains_audio: false,
  contains_credentials: false,
  research_claim_ready: false,
  files: packageFiles.map((path) => ({
    path: relative(outputDir, path),
    bytes: statSync(path).size,
    sha256: sha256(path),
  })),
};
writeText(join(outputDir, "04_Validation/package_manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const archive = spawnSync("zip", ["-r", "-X", zipPath, basename(outputDir)], {
  cwd: dirname(outputDir),
  encoding: "utf8",
});
if (archive.status !== 0) throw new Error(`ZIP creation failed: ${archive.stderr || archive.stdout}`);

console.log(
  JSON.stringify(
    {
      ok: true,
      output_dir: outputDir,
      zip: zipPath,
      file_count: manifest.files.length + 1,
      zip_bytes: statSync(zipPath).size,
    },
    null,
    2,
  ),
);
