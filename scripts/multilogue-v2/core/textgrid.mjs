import { SPEAKERS, round } from './contracts.mjs';

export function buildSixTierTextGrid(duration, interaction) {
  return {
    xmin: 0,
    xmax: round(duration),
    tiers: [
      ...SPEAKERS.map((speaker) => ({
        class: 'IntervalTier',
        name: speaker,
        xmin: 0,
        xmax: round(duration),
        intervals: interaction.speakerTiers[speaker].map(copyInterval),
      })),
      {
        class: 'IntervalTier',
        name: 'floor',
        xmin: 0,
        xmax: round(duration),
        intervals: interaction.floorTier.map(copyInterval),
      },
      {
        class: 'TextTier',
        name: 'transitions',
        xmin: 0,
        xmax: round(duration),
        points: interaction.transitions
          .map((transition) => ({ number: round(transition.point_time), mark: transition.label }))
          .sort((left, right) => left.number - right.number || left.mark.localeCompare(right.mark)),
      },
      {
        class: 'IntervalTier',
        name: 'flags',
        xmin: 0,
        xmax: round(duration),
        intervals: interaction.flagsTier.map(copyInterval),
      },
    ],
  };
}

export function serializeTextGrid(document) {
  const lines = [
    'File type = "ooTextFile"',
    'Object class = "TextGrid"',
    '',
    `xmin = ${formatNumber(document.xmin)}`,
    `xmax = ${formatNumber(document.xmax)}`,
    'tiers? <exists>',
    `size = ${document.tiers.length}`,
    'item []:',
  ];
  document.tiers.forEach((tier, tierIndex) => {
    lines.push(
      `    item [${tierIndex + 1}]:`,
      `        class = "${escapePraat(tier.class)}"`,
      `        name = "${escapePraat(tier.name)}"`,
      `        xmin = ${formatNumber(tier.xmin)}`,
      `        xmax = ${formatNumber(tier.xmax)}`,
    );
    if (tier.class === 'IntervalTier') {
      lines.push(`        intervals: size = ${tier.intervals.length}`);
      tier.intervals.forEach((interval, index) => {
        lines.push(
          `        intervals [${index + 1}]:`,
          `            xmin = ${formatNumber(interval.start)}`,
          `            xmax = ${formatNumber(interval.end)}`,
          `            text = "${escapePraat(interval.text)}"`,
        );
      });
    } else {
      lines.push(`        points: size = ${tier.points.length}`);
      tier.points.forEach((point, index) => {
        lines.push(
          `        points [${index + 1}]:`,
          `            number = ${formatNumber(point.number)}`,
          `            mark = "${escapePraat(point.mark)}"`,
        );
      });
    }
  });
  return `${lines.join('\n')}\n`;
}

export function escapePraat(value) {
  return String(value ?? '').replaceAll('"', '""');
}

function copyInterval(interval) {
  return { start: round(interval.start), end: round(interval.end), text: String(interval.text ?? '') };
}

function formatNumber(value) {
  return Number(value).toFixed(6).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}
