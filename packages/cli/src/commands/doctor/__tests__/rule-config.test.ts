import { describe, expect, it } from 'vitest';

import { makeCtx, makeRegistry } from '#test/ctx-builder';
import type { HouseConfig } from '@houserules/api';
import type { Ctx } from '../../../detect.js';
import { MODULES } from '../../../plan.js';
import { checkRuleConfig } from '../rule-config.js';

function ctxWithRules(rules: Record<string, { paths?: string[] }> | undefined) {
  const base = makeCtx();
  const ctx: Ctx = {
    ...base,
    claude: {
      ...base.claude,
      houseConfig: {
        version: 2,
        modules: ['core', 'code-cleanliness'],
        ...(rules ? { rules } : {}),
      } as unknown as HouseConfig,
    },
  };
  return ctx;
}

const REGISTRY = makeRegistry(MODULES);

describe('checkRuleConfig', () => {
  it('warns on a rules key no enabled module installs, naming the key', () => {
    const result = checkRuleConfig(
      ctxWithRules({ 'code-cleanlines': { paths: ['src/**'] } }),
      REGISTRY,
    );

    expect(result.findings).toEqual([
      expect.objectContaining({
        level: 'WARN',
        msg: expect.stringContaining('code-cleanlines'),
      }),
    ]);
  });

  it('reports nothing for a key naming a rule the enabled modules install', () => {
    const result = checkRuleConfig(
      ctxWithRules({ 'code-cleanliness': { paths: ['src/**'] } }),
      REGISTRY,
    );

    expect(result.findings).toEqual([]);
  });

  it('reports nothing when the config has no rules', () => {
    expect(checkRuleConfig(ctxWithRules(undefined), REGISTRY).findings).toEqual(
      [],
    );
  });
});
