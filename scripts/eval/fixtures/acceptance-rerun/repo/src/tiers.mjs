/** The loyalty tiers, lowest first, by the annual spend in cents that reaches each. */
const TIERS = Object.freeze([
  { name: 'slate', minSpendCents: 0, discountBasisPoints: 0 },
  { name: 'copper', minSpendCents: 250000, discountBasisPoints: 175 },
  { name: 'cobalt', minSpendCents: 900000, discountBasisPoints: 340 },
  { name: 'iridium', minSpendCents: 2400000, discountBasisPoints: 515 },
]);

export function tierFor(annualSpendCents) {
  let reached = TIERS[0];
  for (const tier of TIERS)
    if (annualSpendCents >= tier.minSpendCents) reached = tier;
  return reached.name;
}

export function discountCents(annualSpendCents, invoiceCents) {
  const name = tierFor(annualSpendCents);
  const { discountBasisPoints } = TIERS.find((tier) => tier.name === name);
  return Math.round((invoiceCents * discountBasisPoints) / 10000);
}
