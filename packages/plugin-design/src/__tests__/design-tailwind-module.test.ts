import { describe, expect, it } from 'vitest';

import { useBareRepo, useTailwindRepo } from '#test/tailwind-fixture';

import designPlugin from '../index.js';

import type {
  Ctx,
  ModuleDef,
  PayloadBuilders,
  PluginApi,
} from '@houserules/api';

function apiWithNoPayloadBuilders(): PluginApi {
  return {
    payload: {} as PayloadBuilders,
    packageName: '@houserules/plugin-design',
    alias: 'design',
    config: undefined,
  };
}

function ctxAt(root: string): Ctx {
  return { root, rootPkg: null } as Ctx;
}

function ctxWithThemeEntry(root: string, themeEntry: string): Ctx {
  return {
    root,
    rootPkg: null,
    claude: { houseConfig: { design: { themeEntry } } },
  } as Ctx;
}

function moduleById(id: string): ModuleDef {
  const api = apiWithNoPayloadBuilders();
  const found = designPlugin(api).find((moduleDef) => moduleDef.id === id);
  if (!found) throw new Error(`module ${id} not registered`);
  return found;
}

describe('design-tailwind check', () => {
  it('reads out both Tailwind packages on a repo that has them', () => {
    const moduleDef = moduleById('design-tailwind');
    const root = useTailwindRepo({ withOxide: true });

    const result = moduleDef.check?.(ctxAt(root));

    expect(result?.findings).toEqual([]);
    expect(result?.readouts).toEqual([
      'design: tailwindcss@4.3.3 found',
      'design: @tailwindcss/oxide@4.3.3 found',
    ]);
  });

  it('warns about both packages on a bare repo', () => {
    const moduleDef = moduleById('design-tailwind');
    const root = useBareRepo();

    const result = moduleDef.check?.(ctxAt(root));

    expect(result?.findings).toHaveLength(2);
    expect(result?.findings.map((finding) => finding.level)).toEqual([
      'WARN',
      'WARN',
    ]);
    expect(result?.readouts).toEqual([]);
  });

  it('appends a theme-entry readout after the package readouts when design.themeEntry is configured', () => {
    const moduleDef = moduleById('design-tailwind');
    const root = useTailwindRepo({ withOxide: true });

    const result = moduleDef.check?.(ctxWithThemeEntry(root, 'src/app.css'));

    expect(result?.findings).toEqual([]);
    expect(result?.readouts).toHaveLength(3);
    expect(result?.readouts[0]).toBe('design: tailwindcss@4.3.3 found');
    expect(result?.readouts[1]).toBe('design: @tailwindcss/oxide@4.3.3 found');
    expect(result?.readouts[2]).toContain('design.themeEntry');
    expect(result?.readouts[2]).toContain('src/app.css');
  });
});
