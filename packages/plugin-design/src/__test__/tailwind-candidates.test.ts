import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { scanCandidates } from '../../payload/scripts/lib/tailwind-candidates.mts';
import { useBareRepo, useTailwindRepo } from '#test/tailwind-fixture';

function tempSourceDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tw-candidates-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeSource(dir: string, name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

describe('scanCandidates', () => {
  it('reports a candidate with its 1-based line and column', async () => {
    const root = useTailwindRepo({ withOxide: true });
    const filePath = writeSource(
      tempSourceDir(),
      'Comp.tsx',
      'const x = 1;\nconst cls = "bg-red-500";\n',
    );

    const result = await scanCandidates(root, filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const candidate = result.value.find(
      (entry) => entry.candidate === 'bg-red-500',
    );
    expect(candidate).toEqual({ candidate: 'bg-red-500', line: 2, column: 14 });
  });

  it('converts a byte offset past a multibyte character to the right column', async () => {
    const root = useTailwindRepo({ withOxide: true });
    const filePath = writeSource(
      tempSourceDir(),
      'Comp.tsx',
      'const label = "héllo";\nconst cls = "bg-red-500";\n',
    );

    const result = await scanCandidates(root, filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const candidate = result.value.find(
      (entry) => entry.candidate === 'bg-red-500',
    );
    expect(candidate).toEqual({ candidate: 'bg-red-500', line: 2, column: 14 });
  });

  it('reports the right line past a CRLF line ending', async () => {
    const root = useTailwindRepo({ withOxide: true });
    const filePath = writeSource(
      tempSourceDir(),
      'Comp.tsx',
      'const label = "héllo";\r\nconst cls = "bg-red-500";\r\n',
    );

    const result = await scanCandidates(root, filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const candidate = result.value.find(
      (entry) => entry.candidate === 'bg-red-500',
    );
    expect(candidate).toEqual({ candidate: 'bg-red-500', line: 2, column: 14 });
  });

  it('returns ok:false without crashing the process when the file does not exist', async () => {
    const root = useTailwindRepo({ withOxide: true });

    const result = await scanCandidates(root, join(root, 'does-not-exist.tsx'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('does not exist');
  });

  it('names the install command when @tailwindcss/oxide is not installed', async () => {
    const root = useTailwindRepo();
    const filePath = writeSource(
      tempSourceDir(),
      'Comp.tsx',
      'const cls = "bg-red-500";\n',
    );

    const result = await scanCandidates(root, filePath);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('npm install -D @tailwindcss/oxide@4');
  });

  it('reports the fix with no stack trace on a bare repo', async () => {
    const root = useBareRepo();
    const filePath = writeSource(
      tempSourceDir(),
      'Comp.tsx',
      'const cls = "bg-red-500";\n',
    );

    const result = await scanCandidates(root, filePath);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(
      `@tailwindcss/oxide is not installed in ${root}. Install it in that repo with \`npm install -D @tailwindcss/oxide@4\`.`,
    );
  });
});
