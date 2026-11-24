/** Formats integer cents as dollars, always with a dollar sign and a period. */
export function formatMoney(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Adds integer cent amounts. Throws on a non-integer so a float never enters a total. */
export function addCents(...amounts) {
  for (const amount of amounts) {
    if (!Number.isInteger(amount))
      throw new TypeError(`not integer cents: ${amount}`);
  }
  return amounts.reduce((sum, amount) => sum + amount, 0);
}
