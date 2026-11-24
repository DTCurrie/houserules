/** Each carton code's tare weight in grams and the most items it holds. */
const CARTONS = Object.freeze({
  C1: { tareGrams: 118, capacity: 4 },
  C2: { tareGrams: 164, capacity: 6 },
  C3: { tareGrams: 233, capacity: 9 },
  C4: { tareGrams: 291, capacity: 12 },
  C5: { tareGrams: 377, capacity: 16 },
  C6: { tareGrams: 452, capacity: 20 },
});

export function cartonsNeeded(code, items) {
  return Math.ceil(items / CARTONS[code].capacity);
}

export function packedGrams(code, items, itemGrams) {
  return (
    cartonsNeeded(code, items) * CARTONS[code].tareGrams + items * itemGrams
  );
}
