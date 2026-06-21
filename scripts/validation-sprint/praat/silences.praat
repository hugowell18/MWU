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
invalid_count = 0
if invalid_path$ <> "none" and fileReadable(invalid_path$)
  text$ = readFile$(invalid_path$)
  nlines = 0
  for line to 10000
    l$ = extractLine$(text$, line)
    if l$ <> ""
      s = extractNumber(l$, "")
      e = extractNumber(l$, tab$)
      mid = (s + e) / 2
      iv = Get interval at time: 1, mid
      Set interval text: 1, iv, "invalid"
      invalid_count = invalid_count + 1
    endif
  endfor
endif

selectObject: result
xmax = Get total duration
nint = Get number of intervals: 1
Save as text file: out_path$
writeInfoLine: "OK threshold=", min_silent, " window=", window_size, " nwin=", nwin, " xmax=", xmax, " intervals=", nint, " invalid=", invalid_count
