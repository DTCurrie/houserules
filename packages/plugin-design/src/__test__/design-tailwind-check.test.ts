import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { useBareRepo, useTailwindRepo } from '#test/tailwind-fixture';

const DESIGN_SCRIPT = fileURLToPath(
  new URL('../../payload-dist/scripts/design.mjs', import.meta.url),
);

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_PATH;
  return env;
}

function design(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [DESIGN_SCRIPT, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: cleanEnv(),
  });
}

function writeComponent(root: string, name: string, text: string): void {
  writeFileSync(join(root, name), text);
}

describe('design.mjs check, Tailwind class checking', () => {
  it('names the arbitrary colour and the off-scale padding and exits 1', () => {
    const root = useTailwindRepo({ withOxide: true });
    writeComponent(
      root,
      'Comp.tsx',
      [
        'export function Comp() {',
        '  return <div className="bg-[#3b82f6] p-[13px]" />;',
        '}',
      ].join('\n'),
    );

    const result = design(root, 'check', 'Comp.tsx');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      'Comp.tsx:2  #3b82f6 matches no token. This is a new value and needs a design decision before it joins the token set.',
    );
    expect(result.stdout).toContain(
      'Comp.tsx:2  13px is off the spacing scale',
    );
    expect(result.stdout).toContain('Nearest is 12px.');
  });

  it('reports nothing and exits 0 for a component using only repo theme utilities at correct sizes', () => {
    const root = useTailwindRepo({ withOxide: true });
    writeComponent(
      root,
      'Comp.tsx',
      'export function Comp() {\n  return <div className="bg-brand-500 p-3" />;\n}\n',
    );

    const result = design(root, 'check', 'Comp.tsx');

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('Comp.tsx:');
  });

  it('reports a contrast ratio for a bg-* and text-* pairing sharing one theme colour', () => {
    const root = useTailwindRepo({ withOxide: true });
    writeComponent(
      root,
      'Comp.tsx',
      'export function Comp() {\n  return <div className="bg-brand-500 text-brand-500" />;\n}\n',
    );

    const result = design(root, 'check', 'Comp.tsx');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      'Comp.tsx:2  var(--color-brand-500) on var(--color-brand-500) is 1.00:1, under the 4.5:1 minimum for this declared pair.',
    );
  });

  it('names the real source line, not a line in the synthetic CSS built to check it', () => {
    const root = useTailwindRepo({ withOxide: true });
    writeComponent(
      root,
      'Comp.tsx',
      [
        'export function Comp() {',
        '  return (',
        '    <div className="bg-[#3b82f6]" />',
        '  );',
        '}',
      ].join('\n'),
    );

    const result = design(root, 'check', 'Comp.tsx');

    expect(result.stdout).toContain('Comp.tsx:3  #3b82f6 matches no token');
  });

  it('reports nothing for candidates that are not utilities, in an ordinary Svelte file', () => {
    const root = useTailwindRepo({ withOxide: true });
    writeComponent(
      root,
      'Comp.svelte',
      '<script lang="ts">\n  let isOpen = true;\n  const label = "hi";\n</script>\n<div>{label}</div>\n',
    );

    const result = design(root, 'check', 'Comp.svelte');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'Token coverage: 0/0 design-relevant Tailwind class candidates use a token (0%).',
    );
  });

  it.each([
    [
      'Comp.vue',
      '<template>\n  <div class="bg-[#3b82f6] p-[13px]" />\n</template>\n',
      2,
    ],
    ['comp.astro', '---\n---\n<div class="bg-[#3b82f6] p-[13px]" />\n', 3],
  ])(
    'finds the same arbitrary colour in a %s file, at line %#',
    (name, content, line) => {
      const root = useTailwindRepo({ withOxide: true });
      writeComponent(root, name, content);

      const result = design(root, 'check', name);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain(
        `${name}:${line}  #3b82f6 matches no token`,
      );
    },
  );

  it('reaches a class value inside a clsx-style array, a boolean-guarded object key, and a cva variant map', () => {
    const root = useTailwindRepo({ withOxide: true });
    writeComponent(
      root,
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

    const result = design(root, 'check', 'Comp.svelte');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      'Comp.svelte:6  13px is off the spacing scale',
    );
  });

  it('adds class findings to a style-block finding rather than replacing it', () => {
    const root = useTailwindRepo({ withOxide: true });
    writeComponent(
      root,
      'Comp.svelte',
      [
        '<div class="p-[13px]">hi</div>',
        '',
        '<style>',
        '  div {',
        '    color: #ff0000;',
        '  }',
        '</style>',
      ].join('\n'),
    );

    const result = design(root, 'check', 'Comp.svelte');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      'Comp.svelte:1  13px is off the spacing scale',
    );
    expect(result.stdout).toContain('Comp.svelte:5  #ff0000 matches no token');
  });

  it('labels the coverage denominator as Tailwind class candidates, not declarations', () => {
    const root = useTailwindRepo({ withOxide: true });
    writeComponent(
      root,
      'Comp.tsx',
      'export function Comp() {\n  return <div className="bg-brand-500 p-3" />;\n}\n',
    );

    const result = design(root, 'check', 'Comp.tsx');

    expect(result.stdout).toContain(
      'Token coverage: 1/1 design-relevant Tailwind class candidates use a token (100%).',
    );
  });

  it('omits the declaration coverage line for a component that has no declarations to count', () => {
    const root = useTailwindRepo({ withOxide: true });
    writeComponent(
      root,
      'Comp.tsx',
      'export function Comp() {\n  return <div className="bg-brand-500 p-3" />;\n}\n',
    );

    const result = design(root, 'check', 'Comp.tsx');

    expect(result.stdout).not.toContain('design-relevant declarations');
  });

  it('does not warn that unparsed chunks could hide violations when the class path checked the file', () => {
    const root = useTailwindRepo({ withOxide: true });
    writeComponent(
      root,
      'Comp.tsx',
      'export function Comp() {\n  return <div className="bg-brand-500 p-3" />;\n}\n',
    );

    const result = design(root, 'check', 'Comp.tsx');

    expect(result.stderr).not.toContain('could hide violations');
  });

  it('still reports declaration coverage for a stylesheet, which has declarations and no class names', () => {
    const root = useTailwindRepo({ withOxide: true });
    writeComponent(root, 'card.css', '.card {\n  padding: 24px;\n}\n');

    const result = design(root, 'check', 'card.css');

    expect(result.stdout).toContain('design-relevant declarations');
  });

  it('reports that class checking is unavailable, rather than a clean file, when @tailwindcss/oxide is missing', () => {
    const root = useTailwindRepo();
    writeComponent(
      root,
      'Comp.tsx',
      'export function Comp() {\n  return <div className="bg-[#3b82f6]" />;\n}\n',
    );

    const result = design(root, 'check', 'Comp.tsx');

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('#3b82f6');
    expect(result.stderr).toContain(
      'Comp.tsx: Tailwind class checking is unavailable.',
    );
    expect(result.stderr).toContain('npm install -D @tailwindcss/oxide@4');
  });

  it('keeps the declaration-only coverage line byte-identical in a repo with no Tailwind theme in play', () => {
    const root = useBareRepo();
    mkdirSync(join(root, '.claude/design'), { recursive: true });
    writeFileSync(
      join(root, '.claude/design/tokens.json'),
      JSON.stringify({
        color: {
          $type: 'color',
          red: { $value: { colorSpace: 'srgb', components: [1, 0, 0] } },
        },
      }),
    );
    writeComponent(
      root,
      'styles.css',
      '.box {\n  color: var(--color-red);\n}\n',
    );

    const result = design(
      root,
      '--tokens',
      '.claude/design/tokens.json',
      'check',
      'styles.css',
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      'Token coverage: 1/1 design-relevant declarations use a token (100%).\n',
    );
  });
});
