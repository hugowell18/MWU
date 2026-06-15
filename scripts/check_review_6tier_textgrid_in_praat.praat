form Check 6-tier review TextGrid
    sentence Textgrid_path
endform

textgrid = Read from file: textgrid_path$

selectObject: textgrid
numberOfTiers = Get number of tiers
tier1$ = Get tier name: 1
tier2$ = Get tier name: 2
tier3$ = Get tier name: 3
tier4$ = Get tier name: 4
tier5$ = Get tier name: 5
tier6$ = Get tier name: 6

writeInfoLine: "tiers=", numberOfTiers, " tier1=", tier1$, " tier2=", tier2$, " tier3=", tier3$, " tier4=", tier4$, " tier5=", tier5$, " tier6=", tier6$
