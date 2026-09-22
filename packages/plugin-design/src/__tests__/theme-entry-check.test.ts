import { describe, expect, it } from 'vitest';

import { useTailwindRepo } from '#test/tailwind-fixture';

import { checkThemeEntry } from '../theme-entry-check.js';

import type { Ctx } from '@houserules/api';

function ctxAt(root: string, themeEntry?: string): Ctx {
  return {
    root,
    claude: {
      houseConfig: themeEntry === undefined ? null : { design: { themeEntry } },
    },
  } as Ctx;
}

describe('checkThemeEntry', () => {
  it('reports no findings and no readouts when no config was parsed', () => {
    const root = useTailwindRepo();

    const result = checkThemeEntry(ctxAt(root));

    expect(result.findings).toEqual([]);
    expect(result.readouts).toEqual([]);
  });

  it('reports no findings and no readouts when the config has no themeEntry key', () => {
    const root = useTailwindRepo();

    const result = checkThemeEntry(ctxAt(root, undefined));

    expect(result.findings).toEqual([]);
    expect(result.readouts).toEqual([]);
  });

  it('warns naming design.themeEntry and the path when the configured file is missing', () => {
    const root = useTailwindRepo();

    const result = checkThemeEntry(ctxAt(root, 'src/missing.css'));

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.level).toBe('WARN');
    expect(result.findings[0]?.msg).toContain('design.themeEntry');
    expect(result.findings[0]?.msg).toContain('src/missing.css');
    expect(result.readouts).toEqual([]);
  });

  it('warns naming design.themeEntry and tailwindcss when the configured file does not import it', () => {
    const root = useTailwindRepo({
      cssPath: 'src/plain.css',
      css: '.button { color: red; }\n',
    });

    const result = checkThemeEntry(ctxAt(root, 'src/plain.css'));

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.level).toBe('WARN');
    expect(result.findings[0]?.msg).toContain('design.themeEntry');
    expect(result.findings[0]?.msg).toContain('tailwindcss');
    expect(result.readouts).toEqual([]);
  });

  it('reads out design.themeEntry and the path when the configured file imports tailwindcss', () => {
    const root = useTailwindRepo();

    const result = checkThemeEntry(ctxAt(root, 'src/app.css'));

    expect(result.findings).toEqual([]);
    expect(result.readouts).toHaveLength(1);
    expect(result.readouts[0]).toContain('design.themeEntry');
    expect(result.readouts[0]).toContain('src/app.css');
  });
});
