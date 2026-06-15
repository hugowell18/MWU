form Generate Praat silence TextGrid
    sentence Input_sound
    sentence Output_textgrid
    real Minimum_pitch_Hz 100
    real Time_step_s 0
    real Silence_threshold_dB -50
    real Minimum_silent_interval 0.25
    real Minimum_sounding_interval 0.1
    sentence Silent_label silence
    sentence Sounding_label sounding
endform

sound = Read from file: input_sound$
selectObject: sound
textgrid = To TextGrid (silences): minimum_pitch_Hz, time_step_s, silence_threshold_dB, minimum_silent_interval, minimum_sounding_interval, silent_label$, sounding_label$
selectObject: textgrid
Save as text file: output_textgrid$

writeInfoLine: "praat_silence_textgrid=", output_textgrid$
