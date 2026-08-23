# Layer 2 feasibility thin slice

**Status:** engineering validation only  
**Production milestone:** M4 remains open

## Purpose

This thin slice tests whether the current Layer 1 evidence can traverse the proposed Layer 2
modules without presenting simulated linguistic definitions or unreviewed timing as research data.

## Inputs used

| Input | Feasibility status |
|---|---|
| Original room-mix WAV | Real source evidence |
| Researcher-corrected P025 dynamic N+3 TextGrid | Gold timing/category evidence |
| AssemblyAI speaker-attributed transcript | Pseudo-gold transcript; no accuracy claim |
| MFA word timing | Generated, unreviewed engineering fixture |
| Recording/participant metadata | Mixed real and simulated values |
| AS-unit, clause, MWU, repair and rate definitions | Simulated fixtures only |

## Implemented validation path

1. Validate the reviewed TextGrid duration, dynamic N+3 schema and nine-label vocabulary.
2. Map AssemblyAI provider speakers to canonical S1-SN and split RAW/TIDY transcript files.
3. Run local MFA on short room-mix segments and retain the pure MFA evidence.
4. Build a reference-centric timing table: matched words use MFA timing; unmatched words retain an
   explicit AssemblyAI fallback marker.
5. Generate provisional AS-unit, pause-location, MWU, fluency, lexical and repair tables.
6. Write unresolved items, provenance, machine-readable checks and an early Layer 3 handoff.

## Acceptance boundary

- Technical execution may pass while alignment remains `review_required`.
- MFA support below 95% is reported as `passed_with_alignment_review_required`.
- AssemblyAI fallback keeps the engineering table complete but cannot support a reviewed
  word-level pause/MWU claim.
- Production M4 remains blocked until the client supplies and approves the complete Layer 2 input
  pack described in `requirements.md`.
