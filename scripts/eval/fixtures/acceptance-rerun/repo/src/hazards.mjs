/** Each hazard class's handling fee in cents and its segregation group. */
const HAZARDS = Object.freeze({
  H1: { feeCents: 1250, group: 'A' },
  H2: { feeCents: 875, group: 'B' },
  H3: { feeCents: 2140, group: 'A' },
  H4: { feeCents: 560, group: 'N' },
  H5: { feeCents: 1985, group: 'C' },
  H6: { feeCents: 1320, group: 'B' },
});

export function handlingCents(classes) {
  let total = 0;
  for (const code of new Set(classes)) total += HAZARDS[code].feeCents;
  return total;
}

export function canShareCarton(first, second) {
  const a = HAZARDS[first].group;
  const b = HAZARDS[second].group;
  return a === b || a === 'N' || b === 'N';
}
