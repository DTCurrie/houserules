import { describe, expect, it } from 'vitest';
import {
  WAVE_WORKERS_PER_CORE,
  WORKERS_PER_CORE,
  budgetFor,
  divideShare,
  readSignals,
  shareFor,
  vitestDefaultPool,
} from '../resource-budget.mjs';

const GIB = 1024 ** 3;

describe('budgetFor', () => {
  it('is four workers per core on 18 cores at load 3', () => {
    expect(WORKERS_PER_CORE).toBe(4);
    expect(budgetFor({ ncpu: 18, load1: 3 })).toBe(72);
  });

  it('is two workers per core for a wave, 36 on 18 cores', () => {
    expect(WAVE_WORKERS_PER_CORE).toBe(2);
    expect(
      budgetFor({ ncpu: 18, load1: 3, workersPerCore: WAVE_WORKERS_PER_CORE }),
    ).toBe(36);
  });

  it('halves the cores when load reaches the core count', () => {
    expect(budgetFor({ ncpu: 18, load1: 18 })).toBe(36);
  });

  it('gives 16 on 4 idle cores', () => {
    expect(budgetFor({ ncpu: 4, load1: 0 })).toBe(16);
  });

  it('never halves at the Windows load of 0', () => {
    expect(budgetFor({ ncpu: 18, load1: 0 })).toBe(72);
    expect(budgetFor({ ncpu: 1, load1: 0 })).toBe(4);
  });

  it('floors at 2 when a loaded single core halves to zero', () => {
    expect(budgetFor({ ncpu: 1, load1: 5 })).toBe(2);
  });

  it('leaves the memory term off when no memory figures are given', () => {
    expect(budgetFor({ ncpu: 18, load1: 3 })).toBe(72);
  });

  it('caps the budget by available memory over per-worker memory', () => {
    expect(
      budgetFor({
        ncpu: 18,
        load1: 3,
        memory: { available: 10 * GIB, perWorker: 1 * GIB },
      }),
    ).toBe(10);
  });

  it('keeps the floor of 2 under a tiny memory term', () => {
    expect(
      budgetFor({
        ncpu: 18,
        load1: 3,
        memory: { available: 1 * GIB, perWorker: 4 * GIB },
      }),
    ).toBe(2);
  });

  it('ignores the memory term when per-worker memory is not positive', () => {
    expect(
      budgetFor({
        ncpu: 18,
        load1: 3,
        memory: { available: 1 * GIB, perWorker: 0 },
      }),
    ).toBe(72);
  });
});

describe('shareFor', () => {
  it('gives a run alone the whole budget', () => {
    expect(shareFor(72, 1)).toBe(72);
  });

  it('divides the budget across concurrent runs', () => {
    expect(shareFor(72, 9)).toBe(8);
  });

  it('floors at 1 when runs outnumber the budget', () => {
    expect(shareFor(4, 10)).toBe(1);
  });

  it('counts zero runs as one', () => {
    expect(shareFor(72, 0)).toBe(72);
  });

  it('counts a non-integer run count as one', () => {
    expect(shareFor(72, 2.5)).toBe(72);
  });
});

describe('vitestDefaultPool', () => {
  it('is one under the core count', () => {
    expect(vitestDefaultPool(18)).toBe(17);
  });

  it('never drops below 1', () => {
    expect(vitestDefaultPool(1)).toBe(1);
  });
});

describe('divideShare', () => {
  it('fills the inner pool first on 18 cores alone', () => {
    expect(divideShare(72, 17)).toEqual({ inner: 17, outer: 4 });
  });

  it('halves the outer fan-out at load 18', () => {
    expect(divideShare(36, 17)).toEqual({ inner: 17, outer: 2 });
  });

  it('gives 3 and 5 on 4 idle cores', () => {
    expect(divideShare(16, 3)).toEqual({ inner: 3, outer: 5 });
  });

  it('shrinks the inner pool to the share for a wave of 9', () => {
    expect(divideShare(8, 17)).toEqual({ inner: 8, outer: 1 });
  });

  it('gives 1 and 1 for a share of 1', () => {
    expect(divideShare(1, 17)).toEqual({ inner: 1, outer: 1 });
  });
});

describe('readSignals', () => {
  it('returns three numeric fields', () => {
    const signals = readSignals();

    expect(Object.keys(signals).sort()).toEqual([
      'availableMemory',
      'load1',
      'ncpu',
    ]);
    expect(typeof signals.ncpu).toBe('number');
    expect(typeof signals.load1).toBe('number');
    expect(typeof signals.availableMemory).toBe('number');
  });
});
