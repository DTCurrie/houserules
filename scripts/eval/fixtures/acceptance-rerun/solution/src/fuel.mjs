/** The fuel surcharge for each calendar month, in basis points, January first. */
const MONTHLY_BASIS_POINTS = Object.freeze([
  645, 612, 638, 671, 702, 689, 724, 758, 735, 711, 693, 667,
]);

export function fuelSurchargeCents(cents, month) {
  return Math.round((cents * MONTHLY_BASIS_POINTS[month - 1]) / 10000);
}
