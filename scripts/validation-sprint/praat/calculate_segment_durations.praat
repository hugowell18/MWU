# Headless adaptation of docs/PRAAT Scripts Needed for Our Research/calculate_segment_durations.praat
# (Mietta Lennes, GPL). Same GetTier + per-labelled-interval duration logic, but driven by
# command-line args instead of the interactive form / chooseWriteFile, so the orchestrator can
# run it in the background immediately after TextGrid processing (Phase II, Script 2).
#
#   praat --run calculate_segment_durations.praat <textgrid> <tier_name> <out_txt>
# Output: one line per labelled interval ->  label <tab> duration <tab> start <tab> end

form Calculate durations of labelled segments
  text textgrid_path
  text tier_name
  text out_path
endform

Read from file: textgrid_path$
textgrid = selected("TextGrid")

call GetTier 'tier_name$' tier

writeFile: out_path$, ""
if tier > 0
  numberOfIntervals = Get number of intervals: tier
  for interval from 1 to numberOfIntervals
    label$ = Get label of interval: tier, interval
    if label$ <> ""
      start = Get starting point: tier, interval
      end = Get end point: tier, interval
      duration = end - start
      appendFileLine: out_path$, label$, tab$, fixed$(duration, 12), tab$, fixed$(start, 12), tab$, fixed$(end, 12)
    endif
  endfor
endif

#-------------
# Find the number of a tier that has a given label (from the original script).
procedure GetTier name$ variable$
  numberOfTiers = Get number of tiers
  itier = 1
  repeat
    tier$ = Get tier name: itier
    itier = itier + 1
  until tier$ = name$ or itier > numberOfTiers
  if tier$ <> name$
    'variable$' = 0
  else
    'variable$' = itier - 1
  endif
endproc
