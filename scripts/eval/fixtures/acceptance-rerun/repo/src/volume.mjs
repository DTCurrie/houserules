/** Each service's volumetric divisor, in cubic centimeters per billable kilogram. */
const DIVISORS = Object.freeze({
  STD: 5200,
  EXP: 4300,
  ECO: 6100,
  PAL: 3600,
});

export function billableKg(service, { lengthCm, widthCm, heightCm, kg }) {
  const volumetric = Math.ceil(
    (lengthCm * widthCm * heightCm) / DIVISORS[service],
  );
  return Math.max(Math.ceil(kg), volumetric);
}
