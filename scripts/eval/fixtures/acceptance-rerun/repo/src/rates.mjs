/** Each zone's base charge and its charge per started kilogram, both in cents. */
const ZONE_RATES = Object.freeze({
  1: { baseCents: 485, perKgCents: 112 },
  2: { baseCents: 520, perKgCents: 127 },
  3: { baseCents: 575, perKgCents: 149 },
  4: { baseCents: 610, perKgCents: 163 },
  5: { baseCents: 690, perKgCents: 188 },
  6: { baseCents: 745, perKgCents: 206 },
  7: { baseCents: 830, perKgCents: 231 },
  8: { baseCents: 915, perKgCents: 259 },
});

export function rateCents(zone, grams) {
  const { baseCents, perKgCents } = ZONE_RATES[zone];
  return baseCents + perKgCents * Math.ceil(grams / 1000);
}
