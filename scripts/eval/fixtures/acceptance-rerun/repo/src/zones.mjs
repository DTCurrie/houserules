/** The rating zone of each depot prefix. */
const ZONES = Object.freeze({
  ARV: 1,
  BLY: 3,
  CRN: 2,
  DUW: 6,
  ELK: 4,
  FEN: 8,
  GOR: 5,
  HAX: 7,
});

export function zoneFor(postcode) {
  return ZONES[postcode.slice(0, 3).toUpperCase()];
}

export function zoneSpan(fromPostcode, toPostcode) {
  return Math.abs(zoneFor(fromPostcode) - zoneFor(toPostcode)) + 1;
}
