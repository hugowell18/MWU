# Layer 3 feasibility thin slice

**Status:** engineering validation only  
**Production milestone:** M5 remains open

## Evidence classification

| Layer 3 input | Current evidence |
|---|---|
| Researcher-corrected P025 TextGrid | Gold for canonical labels and independently derived L1 timing values |
| Layer 2 v4 handoff/features | Mixed feasibility evidence; not accepted Layer 2 data |
| Transcript | AssemblyAI pseudo-gold |
| Word timing | Generated MFA with explicit AssemblyAI fallback; unreviewed |
| AS-unit, pause-location, MWU and repair definitions | Simulated fixtures |
| Signed final matrix schema/codebook | Missing; provisional fixture used |
| Multilogue expected rows and validation rules | Missing |
| Approved report/archive format | Missing; specification fixture used |

The SpeakerX monologue workbook remains useful for the earlier deterministic calculation chain,
but it is not a Gold reference for the multilogue lexical/MWU matrix.

## Implemented feasibility path

1. Read the Layer 2 participant handoff, lexical, repair and pause-location tables.
2. Compile one flat R/Python-ready row per canonical speaker under a provisional codebook.
3. Attach field-level provenance to every output column.
4. Independently recompute active vocal duration and P025 own-pause metrics from the researcher
   TextGrid and compare them with the matrix.
5. Keep unsupported values null and preserve upstream unresolved items.
6. Produce CSV, workbook, validation report and artifact manifest outputs.

## Acceptance boundary

- Technical feasibility passes only when schema/type checks and all independently Gold-derived
  comparisons pass.
- The matrix is never marked release-ready while the Layer 2 handoff, schema or expected rows are
  provisional.
- Production M5 remains blocked until the research team signs the matrix schema/codebook and
  supplies representative expected rows plus validation rules.
