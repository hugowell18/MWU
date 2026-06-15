# PRD — AI-Assisted Praat Review Workflow for L2 Dialogic Fluency & Multi-Word Units

**Product:** Six-tier TextGrid annotation pipeline + Excel export for L2 conversational fluency × multi-word-unit (MWU) analysis
**Version:** 0.2 (draft) · **Date:** 2026-06-15 · **Owner:** Hugo / Luke (development)
**Changelog:** 0.2 — Phase 2 expanded into a detailed work-package plan with current implementation status (word-level alignment ✅; clause segmentation / syllable rate / mid-end-clause classification ❌). 0.3 — WP2.1/2.2/2.3/2.5 scaffolds complete: `compute-rate-metrics.mjs`, `tag-clause-boundaries.mjs`, `classify-pause-location.mjs`, `export-research-excel.mjs` (exceljs, 5-sheet workbook). WP2.4 (validation harness) pending gold subset from client.
**Research stakeholders:** Christopher Hollis (PI of study, Tottori U.) · Jon Clenton (Hiroshima U.) · Daniel Hougham · Gavin Brooks (Python/R scripts + PRAAT annotation supervision — technical counterpart)

---

## 1. Background & Goal

### 1.1 Research context
The study investigates the relationship between **L2 conversational (dialogic) fluency** and **vocabulary use, specifically multi-word units / lexical bundles (LBs)**, in **multi-party (3-person) English conversation**. It extends the team's prior monologue-based work (Hougham, Clenton & Uchihara, 2024) into **multilogues**.

Per the KAKEN proposal, the central scientific problem is:

> How do the **length and frequency of lexical bundles** affect dialogic fluency across proficiency (CEFR) levels — and can we distinguish **mid-clause dysfluency (to be penalised)** from **end-clause strategic pausing (to be rewarded)**, which current monologue-based rating scales conflate?

### 1.2 Why a tool
Manual Praat annotation is the largest single labour cost in the research (KAKEN budgets RA PRAAT annotation as the top personnel line). The tool's job is to **drastically reduce manual annotation effort while preserving research-grade defensibility** — it produces *reviewable drafts*, not final data.

### 1.3 Product goal
Turn raw multi-party audio into **structured, human-verified annotation data** that can be fed directly into the team's statistical pipeline (mixed-effects models in R/Python), supporting:
- fluency measures (speed / breakdown / repair),
- pause **location** (mid- vs end-clause) and **type** (silent / filled / between-turn),
- word-level timing (forced alignment),
- MWU/LB segmentation and the **pause-relative-to-MWU** relationship (the study's novel contribution).

---

## 2. Design Principles (non-negotiable)

1. **Drafts, not truth.** Automatic tools generate preliminary annotations and review flags only. Final analysis rests on TextGrids **reviewed and corrected in the real Praat GUI**.
2. **Human-in-the-loop & defensibility.** The method must survive peer review at a leading journal: explicit parameters, recorded tool versions, archived raw ASR, and gold-subset validation.
3. **Two-stage operation.** Stage 1 = review in Praat; Stage 2 = export Excel from the reviewed file. The Excel is generated *only after* the reviewed TextGrid is saved, and by default reads only human-confirmed tiers.
4. **Dialogue is first-class.** Every temporal measure must distinguish **within-turn**, **between-turn (gap)**, and **turn-boundary** silence. The unit of analysis is the **triad**, not the individual.
5. **Validation is part of the method, not polish.** Each phase has explicit acceptance criteria measured against a human gold subset.

---

## 3. Users & Roles

| Role | Who | Responsibility |
|---|---|---|
| Researcher / annotator | Chris + RAs | Opens audio+TextGrid in Praat, uses flags as a guide, corrects core tiers, saves reviewed file |
| Development | Hugo / Luke | Builds the pipeline, alignment, MWU extraction, exporter, validation harness |
| Technical counterpart | Gavin Brooks | Owns downstream Python/R scripts; supervises PRAAT annotation; sign-off on conventions & Excel schema |
| PI / methodology | Hollis / Clenton | Define operational definitions, approve parameters, consume final data |

---

## 4. System Overview

### 4.1 Six-tier TextGrid (review interface)
| Tier | Name | Produced by | Status |
|---|---|---|---|
| T1 | `praat_sounding_silence` | Praat CLI (primary acoustic reference, 250 ms threshold) | human-confirmed → analysis |
| T2 | `local_vad_sounding_silence` | Local acoustic VAD (second reference) | audit only |
| T3 | `sounding_silence_review_status` | Auto: flags where T1≠T2 | audit only |
| T4 | `speaker` | AssemblyAI diarization draft → reviewed | human-confirmed → analysis |
| T5 | `transcript` | AssemblyAI ASR draft (verbatim) → corrected | human-confirmed → analysis |
| T6 | `review_status` | Auto: flags low confidence / speaker uncertainty / ASR concern | audit only |

> Phases 2–3 add derived layers (word alignment, AS-Unit/clause, pause-location, MWU). Whether these live as additional Praat tiers or as side-car data is a design decision in §7.

### 4.2 Two-stage data flow
```
RAW AUDIO
  └─(Phase 1)→ generate T1..T6 draft TextGrid ──► [Stage 1: Praat manual review & correct] ──► reviewed TextGrid (saved)
                                                                                                  │
  ┌───────────────────────────────────────────────────────────────────────────────────────────┘
  └─(Phase 2)→ forced alignment + AS-Unit + pause-location  ──► [review] ──►
  └─(Phase 3)→ MWU extraction + pause↔MWU mapping           ──► [review] ──► [Stage 2: export Excel (long-format)]
                                                                                                  └─► R/Python mixed-effects models
```

---

## 5. Locked Parameters & Operational Definitions

> These must be confirmed by Chris/Gavin in Phase 0. Defaults below are drawn from the cited literature; the value in **bold** is the project default.

| Parameter | Default | Source / note |
|---|---|---|
| Silent-pause threshold | **250 ms** | de Jong & Bosker (2013); Tavakoli & Uchihara (2020). NB: Hougham 2024 used 350 ms — 250 ms supersedes for this project |
| Pause location unit | **AS-Unit** | Foster, Tonkyn & Wigglesworth (2000) |
| Pause location classes | **mid-clause / end-clause / between-turn** | Foster & Tavakoli (2009); +between-turn added for dialogue |
| Pause type | **silent / filled** | filled (uh/um) ≠ pragmatic markers (you know) |
| Speed measure (pure) | **articulation rate = syllables / phonation time** | Tavakoli (2020) |
| Counting unit | **syllables** (not words) | de Jong & Wempe (2009) |
| Syllable detection | **de Jong & Wempe (2009) nuclei method** | required by PI |
| Normalisation denominator | **speaking time (excl. silence)** | Hougham (2025); de Jong (2016b) |
| Short LB | **2–3 words**, text-external, TAALES + COCA spoken, proportion(top 30k)/log-freq/MI | Hougham (2024) |
| Long LB | **4–8 words**, text-internal, AntConc, freq ≥3 & range ≥3 | KAKEN; Biber & Barbieri (2007) |
| LB association threshold | **MI ≥ 3.0** | KAKEN |
| LB refinement | 2× frequency root rule; contractions = 1 word; overlap-merge on shared 3-grams | Wood & Appel (2014); Appel & Wood (2016) |
| Transcript | **verbatim / unpruned** (+ derived cleaned version for n-gram tools) | Tavakoli & Uchihara (2020) |
| Inter-rater reliability target | **Cohen's κ > .85 / Krippendorff α > .80** | KAKEN; BAAL |
| Analysis structure | mixed-effects, **triad & speaker as random effects**, long-format | Uchihara (2026); KAKEN |

---

## 6. Phased Requirements

> Each phase lists: **Goal · Scope (in/out) · Functional requirements · Inputs/Outputs · Acceptance & Validation · Dependencies.**

### Phase 0 — Standards Alignment & Gold Standard (PREREQUISITE)

**Goal:** Lock all conventions against a concrete reference so later phases don't build to the wrong spec.

**Functional requirements**
- F0.1 Obtain **one complete, end-to-end worked reference sample** from the team: raw audio → final corrected TextGrid → word-level alignment (as they'd accept it) → pause-location annotation → MWU segmentation → **final Excel/analysis output**.
- F0.2 If a layer has never been produced (likely word-alignment / MWU), obtain the **conventions** instead; the dev team drafts to those and the team signs off.
- F0.3 Confirm the **§5 parameter table** in writing (with Chris/Gavin).
- F0.4 Confirm the **Excel schema** (the final output format is the binding spec for Phase 3).

**Outputs:** signed-off convention doc; ≥1 closed-loop gold sample; locked parameter table; Excel schema.

**Acceptance:** parameter table and Excel schema explicitly confirmed; at least one gold sample (or a documented agreement on conventions where samples can't yet exist).

**Dependencies:** Chris's data / sample (the email request already sent). **Risk: real corpus not released until mid-July/August 2026** — see §9.

---

### Phase 1 — Six-Tier TextGrid + Praat Review + Baseline Fluency Excel (the MVP demo)

**Goal:** Convert audio into a reviewable 6-tier draft and export baseline fluency measures after human review. This is the "small MVP demo" promised at the 2026-06-12 meeting.

**Scope — in:** T1–T6 generation; two-stage review→export; within-turn vs between-turn silence distinction; baseline speed/breakdown/repair export.
**Scope — out:** word-level alignment, mid/end-clause classification, MWU (Phases 2–3).

**Functional requirements**
- F1.1 **T1 Praat sounding/silence** via Praat CLI, silent-pause threshold **250 ms**, parameters recorded.
- F1.2 **T2 local VAD** as an independent acoustic reference.
- F1.3 **T3 disagreement flag** marking regions where T1≠T2 (tolerance configurable).
- F1.4 **T4 speaker** from AssemblyAI diarization (3 speakers); raw output archived.
- F1.5 **T5 verbatim transcript** from AssemblyAI: preserve fillers, repetitions, false starts, repairs; never auto-clean.
- F1.6 **T6 review flag**: low ASR confidence, speaker uncertainty, overlap regions.
- F1.7 **Two-stage operation**: generate draft → researcher reviews/corrects T1/T4/T5 in Praat GUI → save → export.
- F1.8 **Dialogue silence typing**: classify each silence as within-turn vs between-turn (gap) using T1×T4; do **not** force-attribute between-turn gaps in 3-party audio — flag and retain raw turn boundaries for sensitivity analysis.
- F1.9 **Excel export (baseline)**: per speaker × (per turn + per session), speed/breakdown/repair measures; absolute counts + normalised (per min speaking time / per 100 syllables); dual-report metrics sensitive to between-turn handling (incl./excl.).
- F1.10 **Method log**: Praat version, silence params, VAD params, AssemblyAI params + raw-output date, script version.

**Inputs:** raw audio (WAV ≥16 kHz mono per channel; ideally per-speaker channels).
**Outputs:** 6-tier draft TextGrid; reviewed TextGrid; baseline Excel; method log; archived raw ASR.

**Acceptance & Validation (vs gold subset)**
- Boundary agreement (T1 draft vs human) within tolerance (e.g. ±X ms) reported.
- Pause-count error and total pause-duration error reported.
- Transcript WER / manual correction rate reported.
- T3/T6 flag **recall**: do flags catch the regions humans later correct?
- Edit-rate from draft → final reported.

**Dependencies:** Phase 0. AssemblyAI English-only (confirmed at meeting).

---

### Phase 2 — Word-Level Alignment + Pause-Location (email "Phase 2")

**Goal:** Make pause *location* real by adding validated word-level timing and clause segmentation. Pulled into the MVP path at Jon's explicit request (not a downstream module).

**Scope — in:** forced alignment; AS-Unit/clause segmentation; mid/end-clause + between-turn pause classification; syllable-nuclei articulation rate.
**Scope — out:** MWU extraction (Phase 3).

#### Current implementation status (2026-06-15)

The forced-alignment *spine* exists and has been run end-to-end; the *linguistic* layers on top of it do not exist yet.

| Capability | Status | Evidence / gap |
|---|---|---|
| Reviewed-unit extraction → MFA corpus prep | ✅ done | `extract-reviewed-units.mjs`, `prepare-mfa-corpus.mjs` (ffmpeg clips + `.lab`) |
| Forced alignment (MFA 3.3.9) + global-time merge | ✅ done | `run-forced-alignment.mjs`, `merge-mfa-word-alignments.mjs` → `word_alignment.json` (315 words on elllo sample) |
| Pause extraction @ 250 ms + nearest-word context | ✅ done | `extract-pause-segments.mjs` (35 pauses on elllo) |
| Pause-location classification | 🟡 candidate-only | 26/35 stuck at `word_gap_requires_clause_boundary`; no `mid/end-clause` because no clause tier |
| **AS-Unit / clause segmentation** | ❌ not started | no `tag-clause-boundaries` script; researcher AS-unit transcripts still TBA |
| **Syllable nuclei + articulation/speech rate** | ❌ not started | no nuclei script in repo; de Jong & Wempe (2009) script not yet obtained (R3) |
| **Mid/end-clause + between-turn final labels** | ❌ not started | depends on clause tier |
| Filled-pause vs pragmatic-marker tagging | ❌ not started | needed for breakdown-vs-resource split + Phase 3 |
| Alignment QC (confidence / OOV) | ✅ done (WP2.0) | `merge-mfa-word-alignments.mjs` now reads `alignment_analysis.csv`, attaches per-word `alignment_confidence`/`alignment_flags`/`oov`, emits per-speaker `*_alignment_review_status` tier; flags `missing_alignment` / `unscored` / `low_confidence` / `oov_or_unaligned` |
| Alignment QC (WhisperX comparison) | ❌ not started | second aligner for gold-subset comparison (R8) still to do |
| Validation vs gold subset | ❌ not started | no `validate-against-gold` script; gold subset not yet supplied |
| Repo/integration hygiene | 🟡 mostly fixed (WP2.0) | `LDTWeb/Ldtwebdemo` paths removed from `.praat` helpers; chain re-runs in MWU (`outputs/wp2.0/`). **Residual (human):** reviewed input is still **simulated** — needs one real Praat-reviewed file |

#### Functional requirements (with status)

- F2.1 ✅ **Forced alignment** (MFA primary; WhisperX as comparison — comparison still ❌) producing word-level timestamps from reviewed T5; rough output is acceptable then checked in Praat.
- F2.2 ❌ **Syllable nuclei detection** (de Jong & Wempe, 2009) → articulation rate, mean syllable duration.
- F2.3 ❌ **AS-Unit / clause segmentation** of the transcript (semi-automatic; human-reviewable).
- F2.4 🟡 **Pause-location classification**: each silent pause (≥250 ms) tagged **mid-clause / end-clause / between-turn**, combining alignment + clause + turn tiers. *(Word-gap and turn-boundary candidates exist; mid/end-clause blocked on F2.3.)*
- F2.5 ❌ **Filled-pause & pragmatic-marker tagging** kept distinct (uh/um vs you know/I mean).
- F2.6 ❌ Surface alignment-confidence flags for review.

#### Detailed advancement plan (work packages)

Sequencing: **WP2.0 → (WP2.1 ∥ WP2.2) → WP2.3 → WP2.4 → WP2.5**. WP2.1 (rates) and WP2.2 (clauses) are independent and can run in parallel. Effort sizes are indicative (S ≈ ≤2 d, M ≈ 3–5 d, L ≈ 1–2 wk dev).

| WP | Deliverable | New/changed artifacts | Acceptance | Depends on | Effort |
|---|---|---|---|---|---|
| **WP2.0 Alignment consolidation & QC** — ✅ **done** (engineering); residual = real Praat review | Port pipeline into MWU repo; fix `LDTWeb` paths; re-run on sample; add `alignment_confidence`, OOV list, `alignment_review_status` tier; surface low-confidence words. Replace simulated reviewed input with **one real Praat-reviewed file**. | ✅ `merge-mfa-word-alignments.mjs` gains `--alignment-analysis-csv` / `--min-overall-log-likelihood` / `--max-phone-duration-deviation`, per-word `alignment_confidence`/`alignment_flags`/`oov`, `alignment_review[]`, `summary.alignment_qc`, and per-speaker `*_alignment_review_status` tiers. ✅ `.praat` helpers de-LDTWeb'd. ✅ Re-ran C→D in MWU (`outputs/wp2.0/elllo`, 315 words). ⏳ **Residual (human):** one real Praat-reviewed TextGrid to replace the simulated input. | Pipeline runs in MWU; QC flags populated (verified: `missing_alignment` on AMI, `low_confidence` via threshold) | Phase 1 reviewed output | M |
| **WP2.1 Syllable nuclei + rate metrics** — ✅ **scaffold done** | Integrate de Jong & Wempe (2009) nuclei detection; compute per utterance/speaker/session: syllable count, phonation time (from reviewed T1 sounding), **articulation rate = syll/phonation**, speech rate = syll/total, MLR, phonation-time ratio. Normalise on **speaking time (excl. silence)**. | ✅ `compute-rate-metrics.mjs` → `rate_metrics.json` (session + per-speaker + per-utterance; elllo: artic=4.064 syl/s, PTR=0.858, 315 words). Syllable source pluggable: `heuristic` (default provisional) / `nuclei-csv` (swap in de Jong & Wempe output) / `none`. Per-speaker breakdown (Todd/Simon/…). | Syllable-count agreement vs human Praat counts on gold | de Jong & Wempe script (R3, swap-in ready); WP2.0 | M (blocked on script) |
| **WP2.2 AS-Unit / clause segmentation** — ✅ **Path B scaffold done** | **Path A (primary):** ingest researcher-supplied AS-unit transcripts (blank-line-separated, per HOLLIS directions Step 3) and map AS-units onto the word alignment. **Path B (assist):** rule-based boundary suggestion (ASR punctuation, conjunctions, finite verbs, ≥X ms pauses) for files lacking manual AS-units → human-confirmable. | ✅ `tag-clause-boundaries.mjs` → `clause_segments.json`. Path B implemented: speaker-change / long-gap (default 0.4 s) / clause-initial conjunctions (17-word default list, fully overridable via `--conjunctions`). elllo: 315 words → 61 clauses, mean 5.16 words. Path A (`--as-unit-file`) reserved; throws NotImplemented (files TBA). | Clause-boundary agreement vs human AS-unit files on gold | Researcher AS-unit transcripts **or** approval of auto-suggest; WP2.0 | L |
| **WP2.3 Mid/end-clause + between-turn classification** — ✅ **scaffold done** | Upgrade pause classifier to consume `clause_segments` + word alignment + speaker turns: same clause→`mid_clause`, different clause→`end_clause`, speaker change→`between_turn`, missing info→`unknown`. Also tag **filled pause vs pragmatic marker** on the word tier. Replace candidate flags with final labels + confidence. | ✅ `classify-pause-location.mjs` → `pause_location.json`. elllo: 35 pauses → mid_clause:1, end_clause:25, between_turn:7, leading_pause:1. All rows `review_status="auto_candidate"`. `review_note` warns when clause source is `rule_suggested`. | **Pause-location κ vs human > .85** (Jon's requirement) | WP2.1/WP2.2 | M |
| **WP2.4 Validation harness** | `validate-against-gold.mjs`: word-boundary error (% within ±X ms), syllable-count agreement, pause-location κ, draft→final edit rate. | `validation_report.json`; `Validation` sheet; entries in method log | Reports produced on gold subset; thresholds met or documented | Gold subset (Phase 0); WP2.1–2.3 | M |
| **WP2.5 Export integration** — ✅ **done** | Extend research Excel with `Words`, `Clauses`, `Rates`, `Pauses` (with location) sheets + `Summary`. Replace proprietary `@oai/artifact-tool` with exceljs. | ✅ `export-research-excel.mjs` → `<recording>.research.xlsx`. 5 sheets: Words (315 rows, alignment confidence), Clauses (61), Pauses (35, with location labels), Rates (session + per-speaker + per-utterance), Summary (provenance + QC stats). `exceljs` added as devDependency; no proprietary runtime. | Workbook opens with all sheets, no proprietary dependency | WP2.1–2.3 (WP2.4 adds Validation sheet later) | S–M |

**Inputs:** reviewed Phase-1 TextGrid + audio; (WP2.2) researcher AS-unit-segmented transcripts; (WP2.1) de Jong & Wempe nuclei script; (WP2.4) gold subset.
**Outputs:** word-aligned tier(s) + alignment QC; AS-Unit/clause tier; mid/end-clause/between-turn pause labels; articulation/speech-rate metrics; validation report; extended research Excel.

**Acceptance & Validation (vs gold subset) — Jon's explicit requirement**
- **Word-level alignment accuracy** on the gold subset (e.g. % word boundaries within ±X ms of human).
- Syllable-count agreement vs human Praat counts.
- Pause-location classification agreement (κ) vs human (target > .85).

**Blocking external dependencies — request from Chris/Gavin now**
1. **Gold subset** for ≥1–2 files: human-verified word boundaries + AS-unit-segmented transcripts + human mid/end-clause labels.
2. **de Jong & Wempe (2009)** syllable-nuclei Praat script (or written approval to reimplement) — see R3.
3. **Clause decision:** is rule-based auto-suggest acceptable, or are manual AS-unit transcripts mandatory for every file?
4. **Sign-off on tolerances:** ±X ms word-boundary tolerance and the κ target for pause-location.

**Dependencies:** Phase 1 reviewed output; gold subset with human-verified word boundaries (Phase 0).

---

### Phase 3 — MWU Analysis (email "Phase 3")

**Goal:** Extract MWUs/LBs, align them to the timeline, and compute the study's core construct — **where pauses fall relative to MWUs**.

**Scope — in:** LB extraction (short + long), MWU layer aligned to transcript/timing, pause↔MWU positional analysis, full long-format analytic export.
**Scope — out:** automatic CEFR scoring; rating-scale validation (research workstream, not the tool).

**Functional requirements**
- F3.1 **Short LB (2–3 words)** — text-external via TAALES against COCA spoken; metrics: proportion (top 30k), log-frequency, MI.
- F3.2 **Long LB (4–8 words)** — text-internal via AntConc; threshold freq ≥3 & range ≥3; **Wood & Appel (2014) refinement** (2× root rule, contractions = 1 word, overlap-merge); MI via Collocate.
- F3.3 **Dual transcript handling**: verbatim for fluency; cleaned (no uh/um, spelling fixed) for n-gram tools.
- F3.4 **MWU layer** aligned to word timestamps (each MWU instance: surface text, length, MI/frequency, overlap/nesting flag, source TAALES/AntConc/manual).
- F3.5 **Pause↔MWU positional mapping** (core novel output): for each pause, classify whether it falls **inside / before / after** an MWU, using Phase-2 word alignment.
- F3.6 **Mark task/prompt-borrowed sequences** to control the text-mining confound.
- F3.7 **Analytic Excel export (long-format / tidy)** at event-, turn-, MWU-instance-, and speaker/session-summary granularity, carrying: speaker_id, triad_id, turn_id, CEFR, L1, timestamps, event type, pause-location, pause-type, MWU (length/MI/freq/overlap), articulation rate, repair counts — ready for mixed-effects models with triad/speaker random effects.

**Inputs:** Phase-2 aligned TextGrid + cleaned transcript.
**Outputs:** MWU layer; pause↔MWU table; final long-format analytic Excel.

**Acceptance & Validation**
- MWU segmentation agreement vs human/reference.
- Reproduce Hougham-style LB metrics on a known sample (sanity check).
- Report coverage: % of n-grams scorable against COCA; % conversation-specific sequences excluded.

**Dependencies:** Phase 2 alignment; MWU conventions confirmed (Phase 0).

---

## 7. Data Specifications

### 7.1 TextGrid tier layout (target)
Confirm with Gavin whether derived layers are Praat tiers or side-car:
1. transcript (word-level, time-stamped)
2. speaker / turn (turn boundaries, overlap, between-turn gap)
3. pause (silent/filled, duration, location: mid/end-clause/between-turn)
4. AS-Unit / clause boundary
5. MWU/LB span (length, MI, frequency, overlap)
6. syllable / prosody (for articulation rate)
(+ audit tiers T2/T3/T6 retained.)

### 7.2 Excel schema (binding spec — confirm in Phase 0)
Long-format, one observation per row, examples of granularity: pause-event, repair-event, MWU-instance, turn, speaker-session.
Required columns: identifiers (participant/speaker/triad/turn/task/interaction), metadata (CEFR, L1, gender, study-abroad), fluency metrics (articulation rate, speech rate, mid/end-clause pause count+duration, between-turn latency, repair counts by type), MWU columns (length-bucketed, MI, frequency, overlap, source, pause-relative position), QC columns (double-coded flag, pause-threshold used, clause unit used, alignment accuracy).

---

## 8. Validation & Method Log (cross-cutting)

- **Gold subset** is the calibration anchor for every phase (boundaries, WER, alignment, MWU).
- **Double-coding**: 20% of data independently annotated; report κ/α (targets in §5).
- **Method log** (per file/run): Praat version, silence params, VAD params, AssemblyAI params, raw-ASR date, alignment tool+version, script version, gold-subset validation results, manual-review requirements.
- **Archive** raw cloud ASR output (exact regeneration not guaranteed).

---

## 9. Risks & Open Questions

| # | Risk / question | Impact | Mitigation |
|---|---|---|---|
| R1 | Real corpus not released until mid-July/August 2026; Sept conference deadline | Squeezes Phase 2/3 | Use prior-study sample for Phase 0/1 now; pipeline ready before data lands |
| R2 | Complete gold sample (with word-alignment + MWU) may not exist yet | Blocks P0 ideal path | Fallback: confirm conventions, dev drafts, team signs off (F0.2) |
| R3 | Missing source papers: de Jong & Wempe (2009); "Facets of Fluency" | 250 ms / syllable-rate provenance | Request from Chris |
| R4 | Pause threshold conflict (250 vs 350 ms) | Method consistency | Lock 250 ms, record in method log |
| R5 | Dialogue between-turn pause attribution in 3-party audio | Metric validity | Flag, don't force-attribute; dual-report |
| R6 | Group alignment effect (MWU variance driven by triad) | Misreading individual ability | Triad as random effect; report ICC |
| R7 | MI reliability for sequences >2 words | LB metric validity | Note as limitation; cross-check methods |
| R8 | MFA vs WhisperX accuracy on overlapping/accented L2 speech | Alignment quality | Compare both on gold subset (F2.1) |

---

## 10. Milestones (indicative)

| Milestone | Target | Gate |
|---|---|---|
| M0 Phase 0 conventions + gold sample | on receipt of sample/conventions | parameter & Excel schema signed off |
| M1 Phase 1 MVP demo on a sample file | before first audio batch | passes §6 P1 acceptance |
| M2 Phase 2 alignment + pause-location | after M1 + gold word boundaries | alignment accuracy reported |
| M3 Phase 3 MWU + final Excel | aligned with corpus release (Jul–Aug) | long-format export consumable in R |
| M4 Validation report | before Sept conference | gold-subset results documented |

---

## 11. Out of Scope (v1)

- Automatic CEFR / proficiency scoring.
- IELTS/TOEFL rating-scale development & MFRM validation (research workstream).
- Robust overlapping-speech separation beyond flagging.
- Cross-linguistic (Vietnamese/Spanish) extension (data field kept extensible only).

---

### Appendix A — Reference papers underpinning each requirement
See `文献对照表-Literature-Comparison.md` for the full per-paper mapping. Key anchors: Tavakoli & Wright (2020, measures), de Jong & Wempe (2009, syllables), Foster et al. (2000, AS-Unit), de Jong & Bosker (2013, 250 ms), Tavakoli (2016, dialogue), Hougham et al. (2024 ×2, LB length), Uchihara et al. (2026, dialogue MWS null + triad effect), Takizawa & Suzuki (2025, mid-clause), KAKEN/BAAL (requirements).
