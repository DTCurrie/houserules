import { describe, expect, it } from 'vitest';

import { useBareRepo, useTailwindRepo } from '#test/tailwind-fixture';

import designPlugin from '../index.js';

import type {
  Ctx,
  ModuleDef,
  PayloadBuilders,
  PluginApi,
} from '@houserules/api';

function buildApi(): PluginApi {
  return {
    // Unused here: none of these tests call plan(), only check(), so no builder is invoked.
    payload: {} as PayloadBuilders,
    packageName: '@houserules/plugin-design',
    alias: 'design',
    config: undefined,
  };
}

function ctxAt(root: string): Ctx {
  return { root, rootPkg: null } as Ctx;
}

function moduleById(id: string): ModuleDef {
  const api = buildApi();
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
    expect(result?.findings.every((finding) => finding.level === 'WARN')).toBe(
      true,
    );
    expect(result?.readouts).toEqual([]);
  });
});
