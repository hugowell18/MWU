textgrid = Read from file: "/Users/nedved/Tool/Workspace/MWU/sample-inputs/AMI_ES2002a_Mix-Headset_10min.assemblyai.4tier.TextGrid"

selectObject: textgrid
numberOfTiers = Get number of tiers
tier1$ = Get tier name: 1
tier2$ = Get tier name: 2
tier3$ = Get tier name: 3
tier4$ = Get tier name: 4

writeInfoLine: "tiers=", numberOfTiers, " tier1=", tier1$, " tier2=", tier2$, " tier3=", tier3$, " tier4=", tier4$
