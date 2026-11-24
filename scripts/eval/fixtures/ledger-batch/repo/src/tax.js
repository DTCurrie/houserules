const RATE_PERCENT = 8;

/** Tax for the whole cart, rounded once per line item and then summed. */
export function cartTax(lines) {
  return lines.reduce(
    (sum, line) =>
      sum + Math.round((line.cents * line.quantity * RATE_PERCENT) / 100),
    0,
  );
}
