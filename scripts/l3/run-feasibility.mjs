#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { validateReviewedTextGrid } from "../l2/feasibility-core.mjs";
import {
  buildMatrixRows,
  compareGoldDerived,
  fieldProvenanceRows,
  goldDerivedRows,
  parseCsv,
  provisionalCodebook,
  rowsToCsv,
  validateMatrix,
} from "./feasibility-core.mjs";

const RECORDING_ID = "Multilogue04_C_Level30_D1G4";
const DEFAULTS = {
  l2Run: `outputs/layer2-feasibility/${RECORDING_ID}-l2-feasibility-v4`,
  goldTextGrid: `outputs/multilogue-v2-poc/${RECORDING_ID}_P025_corrected_6tier.TextGrid`,
  outputRoot: "outputs/layer3-feasibility",
  runId: `${RECORDING_ID}-l3-feasibility-v1`,
};

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  const fields = new Map([
    ["--l2-run", "l2Run"],
    ["--gold-textgrid", "goldTextGrid"],
    ["--output-root", "outputRoot"],
    ["--run-id", "runId"],
  ]);
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (fields.has(arg) && argv[index + 1]) {
      args[fields.get(arg)] = argv[index + 1];
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/l3/run-feasibility.mjs [options]

  --l2-run <path>         Layer 2 feasibility run directory
  --gold-textgrid <path> Researcher-corrected P025 TextGrid
  --output-root <path>   Output root
  --run-id <id>          Session-specific Layer 3 run ID
`);
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  return args;
}

function writeText(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function writeJson(path, value) {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
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
  if (existsSync(root)) visit(root);
  return files.sort();
}

function inputInventory(paths, l2Report) {
  return [
    {
      input_id: "L3I-001",
      input: "Researcher-corrected P025 dynamic N+3 TextGrid",
      status: "gold",
      available: true,
      path: paths.goldTextGrid,
      use: "Independent validation of Gold-derived Layer 1 fields",
    },
    {
      input_id: "L3I-002",
      input: "Layer 2 matrix handoff and feature tables",
      status: "mixed_feasibility_evidence",
      available: true,
      path: paths.l2Run,
      use: "Engineering matrix compilation only",
    },
    {
      input_id: "L3I-003",
      input: "Researcher-verified transcript and word alignment",
      status: "missing_replaced_by_pseudo_gold_and_generated_fixture",
      available: false,
      path: "",
      use: `Current L2 research status: ${l2Report.research_status}`,
    },
    {
      input_id: "L3I-004",
      input: "Signed final matrix schema and field codebook",
      status: "missing_replaced_by_provisional_fixture",
      available: false,
      path: "",
      use: "Required before production Layer 3 release",
    },
    {
      input_id: "L3I-005",
      input: "Representative multilogue expected rows and validation rules",
      status: "missing_partial_monologue_reference_only",
      available: false,
      path: "sample/Example fluency measures calculations SpeakerX.xlsx",
      use: "SpeakerX cannot validate multilogue lexical/MWU fields",
    },
    {
      input_id: "L3I-006",
      input: "Approved reporting and archive format",
      status: "missing_replaced_by_spec_fixture",
      available: false,
      path: "spec/requirements.md",
      use: "Current output structure is provisional",
    },
  ];
}

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function htmlReport(report) {
  const inventory = report.input_inventory
    .map(
      (item) => `<tr><td>${item.input_id}</td><td>${htmlEscape(item.input)}</td><td>${htmlEscape(item.status)}</td><td>${item.available ? "yes" : "no"}</td></tr>`,
    )
    .join("");
  const comparison = report.gold_comparison_summary;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Layer 3 Feasibility Report</title><style>
:root{font-family:Inter,Arial,sans-serif;color:#172033;background:#f5f7fb}body{margin:0;padding:32px}.wrap{max-width:1120px;margin:auto}.hero,.section,.metric{background:#fff;border:1px solid #d9e0ec}.hero{border-top:4px solid #275fd6;padding:28px}.badge{display:inline-block;background:#e9f0ff;color:#275fd6;padding:5px 8px;font-size:12px;font-weight:700}.eyebrow{font-size:12px;color:#275fd6;font-weight:700;margin-top:12px}h1{margin:6px 0 10px;font-size:30px}p{color:#5d6c86;line-height:1.55}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:16px 0}.metric{padding:16px}.metric b{display:block;font-size:22px}.metric span{font-size:12px;color:#6d7a91}.warn{color:#a45b06}.pass{color:#137a45}.section{padding:20px;margin-top:16px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:10px;border-bottom:1px solid #e6ebf3}th{color:#5d6c86}@media(max-width:760px){body{padding:12px}.grid{grid-template-columns:1fr 1fr}.section{overflow:auto}}</style></head><body><main class="wrap"><section class="hero"><span class="badge">Engineering feasibility only</span><div class="eyebrow">${htmlEscape(report.run_id)}</div><h1>Layer 3 matrix and validation result</h1><p>The compiler uses Gold-derived Layer 1 values where independent recalculation is possible. All other fields retain their pseudo-gold, generated, simulated or pending provenance.</p></section><div class="grid"><div class="metric"><b class="${report.technical_status === "passed" ? "pass" : "warn"}">${htmlEscape(report.technical_status)}</b><span>technical execution</span></div><div class="metric"><b>${report.matrix.row_count}</b><span>participant rows</span></div><div class="metric"><b>${report.matrix.field_count}</b><span>provisional fields</span></div><div class="metric"><b>${comparison.passed}/${comparison.total}</b><span>Gold-derived checks</span></div></div><section class="section"><h2>Input evidence</h2><table><thead><tr><th>ID</th><th>Input</th><th>Status</th><th>Available</th></tr></thead><tbody>${inventory}</tbody></table></section><section class="section"><h2>Release boundary</h2><p><b>Research release ready: no.</b> ${htmlEscape(report.release_blocker_summary)}</p></section></main></body></html>`;
}

function main() {
  const args = parseArgs(process.argv);
  const paths = {
    l2Run: resolve(args.l2Run),
    goldTextGrid: resolve(args.goldTextGrid),
  };
  const l2Files = {
    report: join(paths.l2Run, "reports", "validation_report.json"),
    handoff: join(paths.l2Run, "outputs", "handoff", "early_phase_v_merge.csv"),
    lexical: join(paths.l2Run, "outputs", "features", "lexical_features.csv"),
    repair: join(paths.l2Run, "outputs", "features", "repair_features.csv"),
    pauses: join(paths.l2Run, "outputs", "features", "pause_location_candidates.csv"),
    unresolved: join(paths.l2Run, "outputs", "features", "unresolved_items.csv"),
  };
  for (const [name, path] of Object.entries({ goldTextGrid: paths.goldTextGrid, ...l2Files })) {
    if (!existsSync(path)) throw new Error(`Missing ${name}: ${path}`);
  }

  const runDir = resolve(args.outputRoot, args.runId);
  const inputsDir = join(runDir, "inputs");
  const outputsDir = join(runDir, "outputs");
  const validationDir = join(runDir, "validation");
  const reportsDir = join(runDir, "reports");
  [inputsDir, outputsDir, validationDir, reportsDir].forEach((directory) => mkdirSync(directory, { recursive: true }));

  const l2Report = JSON.parse(readFileSync(l2Files.report, "utf8"));
  const inventory = inputInventory(paths, l2Report);
  const codebook = provisionalCodebook();
  const matrixRows = buildMatrixRows({
    handoffRows: parseCsv(readFileSync(l2Files.handoff, "utf8")),
    lexicalRows: parseCsv(readFileSync(l2Files.lexical, "utf8")),
    repairRows: parseCsv(readFileSync(l2Files.repair, "utf8")),
    pauseRows: parseCsv(readFileSync(l2Files.pauses, "utf8")),
  });
  const contract = validateReviewedTextGrid(readFileSync(paths.goldTextGrid, "utf8"));
  if (contract.errors.length) throw new Error(`Gold TextGrid validation failed: ${contract.errors.join("; ")}`);
  const goldRows = goldDerivedRows(contract, 0.25);
  const goldComparisons = compareGoldDerived(matrixRows, goldRows);
  const schemaValidation = validateMatrix(matrixRows, codebook);
  const provenance = fieldProvenanceRows(codebook);
  const goldPassed = goldComparisons.filter((comparison) => comparison.status === "passed").length;
  const structuralChecks = [
    { id: "L3F-001", name: "L2 handoff rows match canonical speakers", pass: matrixRows.length === contract.speaker_count },
    { id: "L3F-002", name: "provisional codebook validates matrix types and required fields", pass: schemaValidation.status === "passed" },
    { id: "L3F-003", name: "Gold-derived L1 values independently reconcile", pass: goldPassed === goldComparisons.length },
    { id: "L3F-004", name: "every matrix field has provenance", pass: provenance.length === codebook.length },
    { id: "L3F-005", name: "release remains blocked with provisional inputs", pass: matrixRows.every((row) => row.l3_release_ready === false) },
  ];
  const technicalStatus = structuralChecks.every((check) => check.pass) ? "passed" : "failed";

  writeJson(join(inputsDir, "input_inventory.json"), inventory);
  writeText(join(inputsDir, "input_inventory.csv"), rowsToCsv(inventory));
  writeJson(join(inputsDir, "provisional_codebook.json"), codebook);
  writeText(join(inputsDir, "provisional_codebook.csv"), rowsToCsv(codebook));
  writeText(join(outputsDir, "research_matrix.feasibility.csv"), rowsToCsv(matrixRows, codebook.map((field) => field.field_name)));
  writeText(join(outputsDir, "field_provenance.csv"), rowsToCsv(provenance));
  writeText(join(validationDir, "gold_derived_expected_rows.csv"), rowsToCsv(goldRows));
  writeText(join(validationDir, "gold_derived_comparison.csv"), rowsToCsv(goldComparisons));
  writeJson(join(validationDir, "schema_validation.json"), schemaValidation);
  writeText(join(validationDir, "upstream_unresolved_items.csv"), readFileSync(l2Files.unresolved, "utf8"));

  const report = {
    schema_version: "l3-feasibility-report-v1",
    generated_at: new Date().toISOString(),
    run_id: args.runId,
    technical_status: technicalStatus,
    research_status: "not_ready_signed_schema_gold_rows_and_accepted_l2_required",
    research_claim_ready: false,
    input_inventory: inventory,
    matrix: {
      row_count: matrixRows.length,
      field_count: codebook.length,
      schema_status: "provisional_not_client_signed",
      output: join(outputsDir, "research_matrix.feasibility.csv"),
    },
    gold_comparison_summary: {
      total: goldComparisons.length,
      passed: goldPassed,
      failed: goldComparisons.length - goldPassed,
      scope: "Gold-derived L1 fields only",
    },
    provenance_summary: Object.fromEntries(
      [...Map.groupBy(provenance, (field) => field.provenance_status)].map(([status, fields]) => [status, fields.length]),
    ),
    technical_checks: structuralChecks,
    release_blocker_summary:
      "The final client-signed matrix schema/codebook, accepted Layer 2 evidence, representative multilogue expected rows, validation rules and approved archive/report format are not yet available.",
  };
  writeJson(join(reportsDir, "validation_report.json"), report);
  writeText(
    join(reportsDir, "validation_report.md"),
    `# Layer 3 feasibility result\n\n- Technical status: **${technicalStatus}**\n- Research claim ready: **no**\n- Matrix rows: **${matrixRows.length}**\n- Provisional fields: **${codebook.length}**\n- Gold-derived checks: **${goldPassed}/${goldComparisons.length} passed**\n\nThe matrix compiler and provenance checks are executable. Production Layer 3 remains blocked until the signed schema, accepted Layer 2 handoff and representative expected rows are supplied.\n`,
  );
  writeText(join(reportsDir, "Layer3_Feasibility_Report.html"), htmlReport(report));

  const manifestFiles = listFiles(runDir).filter((path) => basename(path) !== "artifact_manifest.json");
  writeJson(join(runDir, "artifact_manifest.json"), {
    schema_version: "l3-feasibility-artifact-manifest-v1",
    run_id: args.runId,
    generated_at: new Date().toISOString(),
    confidential_research_data: true,
    files: manifestFiles.map((path) => ({
      path: relative(runDir, path),
      bytes: statSync(path).size,
      sha256: sha256(path),
    })),
  });

  console.log(
    JSON.stringify(
      {
        ok: technicalStatus === "passed",
        run_dir: runDir,
        technical_status: technicalStatus,
        research_claim_ready: false,
        matrix_rows: matrixRows.length,
        matrix_fields: codebook.length,
        gold_checks: `${goldPassed}/${goldComparisons.length}`,
        html_report: join(reportsDir, "Layer3_Feasibility_Report.html"),
      },
      null,
      2,
    ),
  );
  if (technicalStatus !== "passed") process.exitCode = 1;
}

main();
