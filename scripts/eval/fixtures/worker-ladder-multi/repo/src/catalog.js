/** Thrown by `lookup` for a SKU the catalog does not hold. */
export class UnknownSkuError extends Error {
  /** @param {unknown} sku */
  constructor(sku) {
    super(`unknown sku ${JSON.stringify(sku)}`);
    this.name = 'UnknownSkuError';
    this.sku = sku;
  }
}

const CATALOG = new Map([
  ['TEA-01', { name: 'Green tea, 100 g', category: 'reduced' }],
  ['BOOK-7', { name: 'Brewing guide', category: 'reduced' }],
  ['MUG-01', { name: 'Stoneware mug', category: 'standard' }],
  ['KETTLE', { name: 'Gooseneck kettle', category: 'standard' }],
  ['GIFT-25', { name: 'Gift card', category: 'voucher' }],
]);

/**
 * The catalog entry for `sku`.
 *
 * @param {string} sku
 * @returns {{ sku: string, name: string, category: string }}
 * @throws {UnknownSkuError}
 */
export function lookup(sku) {
  const entry = CATALOG.get(sku);
  if (entry === undefined) throw new UnknownSkuError(sku);
  return { sku, ...entry };
}
