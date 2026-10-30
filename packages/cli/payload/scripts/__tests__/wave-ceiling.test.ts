import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ceilingFor } from '../wave-ceiling.mjs';

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
