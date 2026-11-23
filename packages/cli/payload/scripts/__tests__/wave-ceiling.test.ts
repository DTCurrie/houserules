import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ceilingFor, waveFigures } from '../wave-ceiling.mjs';

import { useInstalledRepo } from '#test/repo';
import { runScript } from '#test/run';

describe('ceilingFor', () => {
  it.each([
    [{ ncpu: 8, load1: 0 }, 4, 'cpu'],
    [{ ncpu: 8, load1: 8 }, 2, 'cpu+load'],
    [{ ncpu: 1, load1: 0 }, 2, 'cpu'],
    [{ ncpu: 1, load1: 1 }, 1, 'cpu+load'],
    [{ ncpu: 3, load1: 0 }, 2, 'cpu'],
    [{ ncpu: 8, load1: 0, maxWorkers: 16 }, 16, 'maxWorkers'],
    [{ ncpu: 8, load1: 9, maxWorkers: 16 }, 8, 'maxWorkers+load'],
    [{ ncpu: 8, load1: 9, maxWorkers: 1 }, 1, 'maxWorkers+load'],
    [{ ncpu: 8, load1: 0, maxWorkers: 0 }, 4, 'cpu'],
    [{ ncpu: 8, load1: 0, maxWorkers: 2.5 }, 4, 'cpu'],
    [{ ncpu: 8, load1: 0, maxWorkers: -3 }, 4, 'cpu'],
    [{ ncpu: 8, load1: 0, maxWorkers: '6' }, 4, 'cpu'],
  ])('%j gives %i from %s', (input, ceiling, source) => {
    expect(ceilingFor(input)).toEqual({ ceiling, source });
  });
});

describe('waveFigures', () => {
  it('divides the wave budget, half the budget, by the ceiling when no workers are given', () => {
    expect(waveFigures({ ncpu: 18, load1: 3 })).toEqual({
      ceiling: 9,
      ncpu: 18,
      load1: 3,
      source: 'cpu',
      budget: 72,
      share: 4,
    });
  });

  it('divides the wave budget by the workers when given', () => {
    expect(waveFigures({ ncpu: 18, load1: 3, workers: 4 }).share).toBe(9);
  });

  it('halves the budget and ceiling at full load', () => {
    const figures = waveFigures({ ncpu: 18, load1: 18 });

    expect([figures.ceiling, figures.budget, figures.share]).toEqual([
      4, 36, 4,
    ]);
  });

  it('falls back to the ceiling for a zero workers count', () => {
    expect(waveFigures({ ncpu: 18, load1: 3, workers: 0 }).share).toBe(4);
  });
});

describe('wave-ceiling.mjs (installed)', () => {
  const SCRIPT = '.claude/scripts/wave-ceiling.mjs';
  const SOURCES = ['maxWorkers', 'cpu', 'maxWorkers+load', 'cpu+load'];

  it('prints one JSON line with no orchestrate config', () => {
    const root = useInstalledRepo('pnpm-monorepo', { modules: 'orchestrate' });
    const result = runScript(root, SCRIPT);
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(Number.isInteger(parsed.ceiling)).toBe(true);
    expect(parsed.ceiling).toBeGreaterThanOrEqual(1);
    expect(parsed.ncpu).toBeGreaterThanOrEqual(1);
    expect(SOURCES).toContain(parsed.source);
    expect(parsed.source).not.toMatch(/^maxWorkers/);
  });

  it('prints an integer budget and a share within it on a bare run', () => {
    const root = useInstalledRepo('pnpm-monorepo', { modules: 'orchestrate' });

    const result = runScript(root, SCRIPT);

    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(Number.isInteger(parsed.budget)).toBe(true);
    expect(Number.isInteger(parsed.share)).toBe(true);
    expect(parsed.share).toBeLessThanOrEqual(parsed.budget);
  });

  it('gives the whole wave budget as the share for one worker', () => {
    const root = useInstalledRepo('pnpm-monorepo', { modules: 'orchestrate' });

    const result = runScript(root, SCRIPT, { args: ['--workers', '1'] });

    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.share).toBeLessThan(parsed.budget);
    expect(parsed.share).toBeGreaterThanOrEqual(parsed.budget / 2);
  });

  it('ignores a non-numeric workers value and exits 0', () => {
    const root = useInstalledRepo('pnpm-monorepo', { modules: 'orchestrate' });

    const result = runScript(root, SCRIPT, { args: ['--workers', 'abc'] });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim()).share).toBeGreaterThanOrEqual(1);
  });

  it('honors orchestrate.maxWorkers from the config', () => {
    const root = useInstalledRepo('pnpm-monorepo', { modules: 'orchestrate' });
    const configPath = join(root, '.claude/houserules.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.orchestrate = { maxWorkers: 64 };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const result = runScript(root, SCRIPT);
    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect([64, 32]).toContain(parsed.ceiling);
    expect(parsed.source).toMatch(/^maxWorkers/);
  });
});
