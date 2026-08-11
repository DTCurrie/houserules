import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { useBareRepo, useTailwindRepo } from '#test/tailwind-fixture';

import { checkTailwindAvailable } from '../tailwind-check.js';

import type { Ctx } from '@agent-kit/api';

function ctxAt(root: string): Ctx {
  return { root } as Ctx;
}

describe('checkTailwindAvailable', () => {
  it('reports no findings and readouts for both packages when oxide is linked too', () => {
    const root = useTailwindRepo({ withOxide: true });

    const result = checkTailwindAvailable(ctxAt(root));

    expect(result.findings).toEqual([]);
    expect(result.readouts).toEqual([
      'design: tailwindcss@4.3.3 found',
      'design: @tailwindcss/oxide@4.3.3 found',
    ]);
  });

  it('warns about oxide only, and still reads out tailwindcss, when oxide is not linked', () => {
    const root = useTailwindRepo();

    const result = checkTailwindAvailable(ctxAt(root));

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.level).toBe('WARN');
    expect(result.findings[0]?.msg).toContain('@tailwindcss/oxide not found');
    expect(result.readouts).toEqual(['design: tailwindcss@4.3.3 found']);
  });

  it('warns about both packages, each naming an install command, on a bare repo', () => {
    const root = useBareRepo();

    const result = checkTailwindAvailable(ctxAt(root));

    expect(result.findings).toHaveLength(2);
    expect(result.findings.every((finding) => finding.level === 'WARN')).toBe(
      true,
    );
    expect(result.findings[0]?.msg).toContain('npm install -D tailwindcss@^4');
    expect(result.findings[1]?.msg).toContain(
      'npm install -D @tailwindcss/vite@^4',
    );
    expect(result.readouts).toEqual([]);
  });

  it('warns that the manifest could not be parsed, distinctly from "not found", when tailwindcss is installed but its package.json is corrupt', () => {
    const root = useBareRepo();
    const manifestDir = join(root, 'node_modules', 'tailwindcss');
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(join(manifestDir, 'package.json'), '{ not json');

    const result = checkTailwindAvailable(ctxAt(root));

    const tailwindFinding = result.findings.find((finding) =>
      finding.msg.includes('tailwindcss'),
    );
    expect(tailwindFinding?.msg).toContain('could not be parsed');
    expect(tailwindFinding?.msg).not.toContain('tailwindcss not found');
  });
});
