import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkDesignTokens, TOKENS_PATH } from '../seed-check.js';
import { renderTokenSeed } from '../tokens-seed.js';

import type { Ctx } from '@agent-kit/cli/plugin';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'plugin-design-'));
}

function ctxAt(root: string): Ctx {
  return { root } as Ctx;
}

describe('checkDesignTokens', () => {
  it('warns when the token file is missing', () => {
    const root = tempRoot();

    const result = checkDesignTokens(ctxAt(root));

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.level).toBe('WARN');
    expect(result.findings[0]?.msg).toContain(TOKENS_PATH);
  });

  it('reports an error-level finding for invalid JSON', () => {
    const root = tempRoot();
    mkdirSync(join(root, '.claude/design'), { recursive: true });
    writeFileSync(join(root, TOKENS_PATH), '{ not json');

    const result = checkDesignTokens(ctxAt(root));

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.level).toBe('ERROR');
  });

  it('warns when the seed is untouched', () => {
    const root = tempRoot();
    mkdirSync(join(root, '.claude/design'), { recursive: true });
    writeFileSync(join(root, TOKENS_PATH), renderTokenSeed());

    const result = checkDesignTokens(ctxAt(root));

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.level).toBe('WARN');
    expect(result.findings[0]?.msg).toContain('placeholder');
  });

  it('produces no findings and one readout for an edited token file', () => {
    const root = tempRoot();
    mkdirSync(join(root, '.claude/design'), { recursive: true });
    writeFileSync(
      join(root, TOKENS_PATH),
      renderTokenSeed().replace('0.231', '0.5'),
    );

    const result = checkDesignTokens(ctxAt(root));

    expect(result.findings).toHaveLength(0);
    expect(result.readouts).toHaveLength(1);
    expect(result.readouts[0]).toContain(TOKENS_PATH);
  });
});
