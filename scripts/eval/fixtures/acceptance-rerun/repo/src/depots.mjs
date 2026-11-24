/** Each depot's booking cutoff hour and its transit days to the hub. */
const DEPOTS = Object.freeze({
  ARV: { cutoffHour: 16, transitDays: 2 },
  BLY: { cutoffHour: 17, transitDays: 3 },
  CRN: { cutoffHour: 15, transitDays: 1 },
  DUW: { cutoffHour: 18, transitDays: 4 },
  ELK: { cutoffHour: 14, transitDays: 2 },
  FEN: { cutoffHour: 16, transitDays: 5 },
  GOR: { cutoffHour: 17, transitDays: 3 },
});

export function etaDays(depot, bookedHour) {
  const { cutoffHour, transitDays } = DEPOTS[depot];
  return transitDays + (bookedHour >= cutoffHour ? 1 : 0);
}
