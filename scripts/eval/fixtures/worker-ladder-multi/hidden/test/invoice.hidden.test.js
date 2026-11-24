import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { UnknownSkuError } from '../src/catalog.js';
import { buildInvoice } from '../src/invoice.js';
import { checkInvoice } from '../src/invoice-contract.js';

const mug = (qty = 1, unitCents = 1000) => ({ sku: 'MUG-01', qty, unitCents });
const tea = (qty = 1, unitCents = 1000) => ({ sku: 'TEA-01', qty, unitCents });
const seconds = (qty = 1, unitCents = 1000) => ({
  sku: 'MUG-2ND',
  qty,
  unitCents,
});
const book = (qty = 1, unitCents = 1000) => ({ sku: 'BOOK-7', qty, unitCents });
const kettle = (qty = 1, unitCents = 4999) => ({
  sku: 'KETTLE',
  qty,
  unitCents,
});
const gift = (qty = 1, unitCents = 2500) => ({
  sku: 'GIFT-25',
  qty,
  unitCents,
});

function assertRangeError(order, options) {
  assert.throws(
    () => buildInvoice(order, options),
    RangeError,
    `${JSON.stringify({ order, options })} should throw RangeError`,
  );
}

describe('validation', () => {
  for (const order of [
    null,
    undefined,
    'MUG-01',
    { sku: 'MUG-01', qty: 1, unitCents: 1000 },
  ]) {
    test(`throws TypeError for a non-array order ${JSON.stringify(order)}`, () => {
      assert.throws(() => buildInvoice(order), TypeError);
    });
  }

  for (const qty of [0, -1, 1.5, '2', Number.NaN]) {
    test(`rejects qty ${String(qty)}`, () => {
      assertRangeError([mug(qty)]);
    });
  }

  for (const unitCents of [-1, 12.5, '1000', Number.NaN]) {
    test(`rejects unitCents ${String(unitCents)}`, () => {
      assertRangeError([mug(1, unitCents)]);
    });
  }

  for (const couponCents of [-1, 0.5, '100']) {
    test(`rejects couponCents ${String(couponCents)}`, () => {
      assertRangeError([mug()], { couponCents });
    });
  }

  test('allows a zero unit price', () => {
    assert.equal(buildInvoice([mug(3, 0)]).totalCents, 0);
  });

  test('throws the catalog UnknownSkuError for an unknown sku', () => {
    assert.throws(
      () => buildInvoice([{ sku: 'SPOON', qty: 1, unitCents: 100 }]),
      (error) => error instanceof UnknownSkuError && error.sku === 'SPOON',
    );
  });

  test('builds without an options argument', () => {
    assert.equal(buildInvoice([mug()]).totalCents, 1200);
  });

  test('leaves the order objects unchanged', () => {
    const order = [mug(1), tea(2), mug(3)];
    const before = structuredClone(order);

    buildInvoice(order, { couponCents: 300 });

    assert.deepEqual(order, before);
  });
});

describe('merging', () => {
  test('merges repeated skus into the first line, summing qty', () => {
    const invoice = buildInvoice([mug(1), tea(2), mug(3)]);

    assert.deepEqual(
      invoice.lines.map((line) => [line.sku, line.qty, line.grossCents]),
      [
        ['MUG-01', 4, 4000],
        ['TEA-01', 2, 2000],
      ],
    );
  });

  test('rejects one sku at two unit prices', () => {
    assertRangeError([mug(1, 1000), mug(1, 1100)]);
  });

  test('records each line category from the catalog', () => {
    assert.deepEqual(
      buildInvoice([tea(), gift(), mug()]).lines.map((line) => line.category),
      ['reduced', 'voucher', 'standard'],
    );
  });
});

describe('coupon', () => {
  test('gives a gift card no share of the coupon', () => {
    const invoice = buildInvoice([gift(1, 2500), mug(1, 1000)], {
      couponCents: 300,
    });

    assert.deepEqual(
      invoice.lines.map((line) => line.discountCents),
      [0, 300],
    );
  });

  test('caps the coupon at the discountable gross', () => {
    const invoice = buildInvoice([mug(1, 1000), gift(1, 2500)], {
      couponCents: 5000,
    });

    assert.equal(invoice.discountCents, 1000);
    assert.equal(invoice.totalCents, 2500);
  });

  test('applies no discount to an order of gift cards only', () => {
    const invoice = buildInvoice([gift(2, 2500)], { couponCents: 1000 });

    assert.equal(invoice.discountCents, 0);
    assert.equal(invoice.totalCents, 5000);
  });

  test('gives the leftover cent to the earlier line on a tie', () => {
    const invoice = buildInvoice([tea(1, 500), mug(1, 500)], {
      couponCents: 1,
    });

    assert.deepEqual(
      invoice.lines.map((line) => line.discountCents),
      [1, 0],
    );
  });

  test('weights the split by gross, not unit price', () => {
    const invoice = buildInvoice([tea(3, 100), mug(1, 100)], {
      couponCents: 100,
    });

    assert.deepEqual(
      invoice.lines.map((line) => line.discountCents),
      [75, 25],
    );
  });

  test('splits by gross after merging repeated skus', () => {
    const invoice = buildInvoice([tea(1, 100), mug(1, 100), tea(2, 100)], {
      couponCents: 100,
    });

    assert.deepEqual(
      invoice.lines.map((line) => line.discountCents),
      [75, 25],
    );
  });
});

describe('coupon caps', () => {
  test('caps the coupon at the sum of the line caps', () => {
    const invoice = buildInvoice([seconds(1, 1000), mug(1, 1000), gift()], {
      couponCents: 5000,
    });

    assert.deepEqual(
      invoice.lines.map((line) => line.discountCents),
      [200, 1000, 0],
    );
    assert.equal(invoice.totalCents, 3460);
  });

  test('keeps re-splitting until no line is over its cap', () => {
    const invoice = buildInvoice(
      [seconds(1, 1000), tea(1, 1000), mug(1, 1000)],
      { couponCents: 1500 },
    );

    assert.deepEqual(
      invoice.lines.map((line) => line.discountCents),
      [200, 500, 800],
      'a single re-split gives [200, 650, 650], the tea line over its 500 cap',
    );
  });

  test('holds a line the second split pushes over its cap', () => {
    const invoice = buildInvoice(
      [kettle(1, 1499), book(2, 350), seconds(1, 1250)],
      { couponCents: 1400 },
    );

    assert.deepEqual(
      invoice.lines.map((line) => line.discountCents),
      [800, 350, 250],
      'a single re-split gives [784, 366, 250], the book line over its 350 cap',
    );
  });

  test('rounds a cap on an exact half cent down to even', () => {
    const invoice = buildInvoice([tea(1, 1001), mug(1, 1001)], {
      couponCents: 2000,
    });

    assert.deepEqual(
      invoice.lines.map((line) => line.discountCents),
      [500, 1001],
    );
  });

  test('rounds a cap on an exact half cent up to even', () => {
    const invoice = buildInvoice([tea(1, 1003), mug(1, 1003)], {
      couponCents: 5000,
    });

    assert.deepEqual(
      invoice.lines.map((line) => line.discountCents),
      [502, 1003],
      'a floored cap gives the tea line 501',
    );
  });
});

describe('tax', () => {
  test('rounds an exact half cent down to even', () => {
    assert.equal(buildInvoice([tea(1, 10)]).taxCents, 0);
  });

  test('rounds an exact half cent up to even', () => {
    assert.equal(buildInvoice([tea(1, 30)]).taxCents, 2);
  });

  test('rounds tax per line, not on the total', () => {
    const invoice = buildInvoice([
      tea(1, 10),
      { sku: 'BOOK-7', qty: 1, unitCents: 10 },
    ]);

    assert.equal(invoice.taxCents, 0);
  });

  test('charges no tax on a gift card', () => {
    assert.equal(buildInvoice([gift(1, 2500)]).taxCents, 0);
  });
});

describe('empty order', () => {
  test('returns no lines and zero totals', () => {
    assert.deepEqual(buildInvoice([]), {
      lines: [],
      subtotalCents: 0,
      discountCents: 0,
      taxCents: 0,
      totalCents: 0,
    });
  });

  test('ignores a coupon', () => {
    assert.equal(buildInvoice([], { couponCents: 500 }).discountCents, 0);
  });
});

describe('invariants', () => {
  const orders = [
    [[mug(3, 333), tea(7, 149), gift(1, 2500)], 997],
    [[tea(1, 1), mug(1, 1), { sku: 'BOOK-7', qty: 1, unitCents: 1 }], 2],
    [
      [
        { sku: 'KETTLE', qty: 2, unitCents: 4999 },
        tea(5, 275),
        mug(1, 1250),
        tea(1, 275),
      ],
      1234,
    ],
    [[mug(1, 7), gift(1, 2500)], 100],
    [[seconds(1, 1000), tea(1, 1000), mug(1, 1000)], 1500],
    [[kettle(1, 1499), book(2, 350), seconds(1, 1250)], 1400],
  ];
  for (const [order, couponCents] of orders) {
    test(`holds for ${order.map((line) => `${line.qty}x${line.sku}`).join(',')} with coupon ${couponCents}`, () => {
      assert.deepEqual(checkInvoice(buildInvoice(order, { couponCents })), []);
    });
  }

  test('totals a mixed order with a coupon and a gift card', () => {
    const invoice = buildInvoice([mug(3, 333), tea(7, 149), gift(1, 2500)], {
      couponCents: 997,
    });

    assert.deepEqual(
      [
        invoice.subtotalCents,
        invoice.discountCents,
        invoice.taxCents,
        invoice.totalCents,
      ],
      [4542, 997, 129, 3674],
    );
  });
});
