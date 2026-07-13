# Phase II — Script 1: intensity / silence detection loop (email Phase II).
# Rolling intensity analysis over `window_size`-second windows for a stable baseline on long
# recordings, then the windows are reassembled and Praat "Scale times" is applied so the output
# covers the FULL, unsegmented timeline (xmin 0 .. xmax = original audio duration).
# Labels: sounding / silent ( / invalid when a Phase-I invalid-intervals file is supplied ).
#
#   praat --run silences.praat <wav> <out_textgrid> <min_silent> <thr_db> <min_sounding> <min_pitch> <window_size> <invalid_path|none>

form silences
  text wav_path
  text out_path
  real min_silent
  real silence_threshold_db
  real min_sounding
  real min_pitch
  real window_size
  text invalid_path
endform

Read from file: wav_path$
sound = selected("Sound")
total = Get total duration
nwin = ceiling(total / window_size)

# rolling intensity / silence detection per window
for w to nwin
  ws = (w - 1) * window_size
  we = w * window_size
  if we > total
    we = total
  endif
  selectObject: sound
  part = Extract part: ws, we, "rectangular", 1, "no"
  tg[w] = To TextGrid (silences): min_pitch, 0, silence_threshold_db, min_silent, min_sounding, "silent", "sounding"
  removeObject: part
endfor

# reassemble windows onto one timeline
selectObject: tg[1]
for w from 2 to nwin
  plusObject: tg[w]
endfor
if nwin > 1
  Concatenate
  result = selected("TextGrid")
else
  result = tg[1]
endif

# Scale times: mathematically unroll to the full original timeline (xmin 0 .. xmax total)
selectObject: result
Scale times to: 0, total

# Optional: relabel "invalid" regions (other speakers talking; from Phase I). Skipped for monologue.
# The input is a headerless TSV with one <start><tab><end> range per line. Insert both range
# boundaries first, then label every resulting interval inside the range. This preserves the exact
# Phase-I handoff times even when an invalid range crosses several Praat sounding/silent intervals.
invalid_range_count = 0
invalid_count = 0
short_silent_relabelled = 0
if invalid_path$ <> "none" and fileReadable(invalid_path$)
  Read Strings from raw text file: invalid_path$
  invalidStrings = selected("Strings")
  nlines = Get number of strings

  for line to nlines
    row$ = Get string: line
    if row$ <> ""
      range_start = extractNumber(row$, "")
      range_end = extractNumber(row$, tab$)
      if range_start < 0
        range_start = 0
      endif
      if range_end > total
        range_end = total
      endif
      if range_end > range_start
        invalid_range_count = invalid_range_count + 1
        invalid_start[invalid_range_count] = range_start
        invalid_end[invalid_range_count] = range_end
      endif
    endif
  endfor

  removeObject: invalidStrings
  selectObject: result

  # Split the tier at every invalid start/end unless that boundary already exists.
  for range to invalid_range_count
    range_start = invalid_start[range]
    range_end = invalid_end[range]

    if range_start > 0 and range_start < total
      iv = Get interval at time: 1, range_start
      iv_start = Get starting point: 1, iv
      iv_end = Get end point: 1, iv
      if abs(range_start - iv_start) > 0.000000001 and abs(range_start - iv_end) > 0.000000001
        original_label$ = Get label of interval: 1, iv
        Insert boundary: 1, range_start
        Set interval text: 1, iv, original_label$
        Set interval text: 1, iv + 1, original_label$
      endif
    endif

    if range_end > 0 and range_end < total
      iv = Get interval at time: 1, range_end
      iv_start = Get starting point: 1, iv
      iv_end = Get end point: 1, iv
      if abs(range_end - iv_start) > 0.000000001 and abs(range_end - iv_end) > 0.000000001
        original_label$ = Get label of interval: 1, iv
        Insert boundary: 1, range_end
        Set interval text: 1, iv, original_label$
        Set interval text: 1, iv + 1, original_label$
      endif
    endif
  endfor

  # Boundaries now align exactly, so midpoint membership labels every complete invalid interval.
  nint = Get number of intervals: 1
  for iv to nint
    iv_start = Get starting point: 1, iv
    iv_end = Get end point: 1, iv
    mid = (iv_start + iv_end) / 2
    is_invalid = 0
    for range to invalid_range_count
      if mid >= invalid_start[range] and mid < invalid_end[range]
        is_invalid = 1
      endif
    endfor
    if is_invalid
      Set interval text: 1, iv, "invalid"
      invalid_count = invalid_count + 1
    endif
  endfor

  # An invalid boundary can split a previously valid silent interval and leave a tiny silent
  # remainder. It no longer meets this run's minimum-silence definition, so keep it inside the
  # surrounding sounding time rather than count it as a pause.
  nint = Get number of intervals: 1
  for iv to nint
    label$ = Get label of interval: 1, iv
    if label$ = "silent"
      iv_start = Get starting point: 1, iv
      iv_end = Get end point: 1, iv
      if iv_end - iv_start < min_silent - 0.000000001
        Set interval text: 1, iv, "sounding"
        short_silent_relabelled = short_silent_relabelled + 1
      endif
    endif
  endfor
endif

selectObject: result
xmax = Get total duration
nint = Get number of intervals: 1
Save as text file: out_path$
writeInfoLine: "OK threshold=", min_silent, " window=", window_size, " nwin=", nwin, " xmax=", xmax, " intervals=", nint, " invalid_ranges=", invalid_range_count, " invalid_intervals=", invalid_count, " short_silent_relabelled=", short_silent_relabelled
