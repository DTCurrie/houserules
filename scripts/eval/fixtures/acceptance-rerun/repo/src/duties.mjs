/** Each customs category's duty in basis points and its duty-free allowance in cents. */
const DUTIES = Object.freeze({
  K10: { basisPoints: 420, allowanceCents: 15000 },
  K20: { basisPoints: 865, allowanceCents: 8000 },
  K30: { basisPoints: 1240, allowanceCents: 5000 },
  K40: { basisPoints: 310, allowanceCents: 20000 },
  K50: { basisPoints: 1575, allowanceCents: 2500 },
});

export function dutyCents(category, valueCents) {
  const { basisPoints, allowanceCents } = DUTIES[category];
  if (valueCents <= allowanceCents) return 0;
  return Math.round(((valueCents - allowanceCents) * basisPoints) / 10000);
}
