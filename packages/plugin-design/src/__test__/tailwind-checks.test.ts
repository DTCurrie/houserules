import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { checkTailwindClasses } from '../../payload/scripts/lib/tailwind-checks.mts';
import { loadDesignSystem } from '../../payload/scripts/lib/tailwind-design-system.mts';
import type { LoadedDesignSystem } from '../../payload/scripts/lib/tailwind-design-system.mts';
import { projectThemeToDtcg } from '../../payload/scripts/lib/tailwind-theme-to-dtcg.mts';
import { useTailwindRepo } from '#test/tailwind-fixture';

interface Fixture {
  root: string;
  designSystem: LoadedDesignSystem;
  tokens: Record<string, unknown>;
}

async function setup(): Promise<Fixture> {
  const root = useTailwindRepo({ withOxide: true });
  const loaded = await loadDesignSystem(root, join(root, 'src/app.css'));
  if (!loaded.ok) throw new Error(loaded.error);
  const { document } = projectThemeToDtcg(loaded.value.theme);
  return { root, designSystem: loaded.value, tokens: document };
}

function tempSourceDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tw-checks-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeComponent(name: string, text: string): string {
  const path = join(tempSourceDir(), name);
  writeFileSync(path, text);
  return path;
}

describe('checkTailwindClasses', () => {
  it('names the arbitrary colour and the off-scale padding at the real line number', async () => {
    const { root, designSystem, tokens } = await setup();
    const filePath = writeComponent(
      'Comp.tsx',
      [
        'export function Comp() {',
        '  return <div className="bg-[#3b82f6] p-[13px]" />;',
        '}',
      ].join('\n'),
    );

    const result = await checkTailwindClasses(
      root,
      filePath,
      designSystem,
      tokens,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const colourFinding = result.value.findings.find((finding) =>
      finding.message.includes('#3b82f6'),
    );
    const paddingFinding = result.value.findings.find((finding) =>
      finding.message.includes('13px'),
    );
    expect(colourFinding).toEqual({
      line: 2,
      message:
        '#3b82f6 matches no token. This is a new value and needs a design decision before it joins the token set.',
    });
    expect(paddingFinding?.line).toBe(2);
    expect(paddingFinding?.message).toContain('off the spacing scale');
  });

  it('reports nothing for a component using only repo-defined theme utilities at correct sizes', async () => {
    const { root, designSystem, tokens } = await setup();
    const filePath = writeComponent(
      'Comp.tsx',
      'export function Comp() {\n  return <div className="bg-brand-500 p-3" />;\n}\n',
    );

    const result = await checkTailwindClasses(
      root,
      filePath,
      designSystem,
      tokens,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings).toEqual([]);
  });

  it('resolves a bg-* and text-* pairing sharing one theme colour through the theme, ratio 1.00:1', async () => {
    const { root, designSystem, tokens } = await setup();
    const filePath = writeComponent(
      'Comp.tsx',
      'export function Comp() {\n  return <div className="bg-brand-500 text-brand-500" />;\n}\n',
    );

    const result = await checkTailwindClasses(
      root,
      filePath,
      designSystem,
      tokens,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings).toEqual([
      {
        line: 2,
        message:
          'var(--color-brand-500) on var(--color-brand-500) is 1.00:1, under the 4.5:1 minimum for this declared pair. A rendered page composites more than these two declarations, so this is not what a user necessarily sees.',
      },
    ]);
  });

  it('reports a contrast ratio for a bg-* and text-* pairing sharing one arbitrary colour', async () => {
    const { root, designSystem, tokens } = await setup();
    const filePath = writeComponent(
      'Comp.tsx',
      'export function Comp() {\n  return <div className="bg-[#3b82f6] text-[#3b82f6]" />;\n}\n',
    );

    const result = await checkTailwindClasses(
      root,
      filePath,
      designSystem,
      tokens,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const contrastFinding = result.value.findings.find((finding) =>
      finding.message.includes('1.00:1'),
    );
    expect(contrastFinding?.line).toBe(2);
    expect(contrastFinding?.message).toContain('under the 4.5:1 minimum');
  });

  it('reports nothing for candidates that are not utilities', async () => {
    const { root, designSystem, tokens } = await setup();
    const filePath = writeComponent(
      'Comp.tsx',
      'const isOpen = true;\nconst label = "hi";\n',
    );

    const result = await checkTailwindClasses(
      root,
      filePath,
      designSystem,
      tokens,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings).toEqual([]);
  });

  it('reaches a class value inside a clsx-style array, a boolean-guarded object key, and a cva variant map', async () => {
    const { root, designSystem, tokens } = await setup();
    const filePath = writeComponent(
      'Comp.svelte',
      [
        '<script lang="ts">',
        '  let { isOpen } = $props();',
        "  const styles = cva('inline-flex p-3', { variants: { size: { sm: 'p-2', lg: 'p-4' } } });",
        '</script>',
        '',
        "<div class={['rounded-md bg-brand-500', isOpen && 'ring-2 ring-accent', { 'p-[13px]': true }]}>",
        '  <span class="text-hero font-bold">hi</span>',
        '</div>',
      ].join('\n'),
    );

    const result = await checkTailwindClasses(
      root,
      filePath,
      designSystem,
      tokens,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paddingFinding = result.value.findings.find((finding) =>
      finding.message.includes('13px'),
    );
    expect(paddingFinding?.line).toBe(6);
  });

  it('returns ok:false naming the fix when the file could not be scanned', async () => {
    const { root, designSystem, tokens } = await setup();

    const result = await checkTailwindClasses(
      root,
      join(root, 'does-not-exist.tsx'),
      designSystem,
      tokens,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('does not exist');
  });
});
