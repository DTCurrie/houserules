import { describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkDesignTokens,
  checkStaleTokenSeed,
  TOKENS_PATH,
} from '../seed-check.js';
import { renderTokenSeed } from '../tokens-seed.js';

import type { Ctx } from '@agent-kit/cli/plugin';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'plugin-design-'));
}

function ctxAt(root: string): Ctx {
  return { root } as Ctx;
}

function chmodMakesFileUnreadable(): boolean {
  const root = tempRoot();
  const probe = join(root, 'probe');
  writeFileSync(probe, 'x');
  chmodSync(probe, 0o000);
  try {
    readFileSync(probe, 'utf8');
    return false;
  } catch {
    return true;
  }
}

const CHMOD_ENFORCES_UNREADABLE = chmodMakesFileUnreadable();

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

  it.skipIf(!CHMOD_ENFORCES_UNREADABLE)(
    'warns that the token file could not be read when it exists but is unreadable',
    () => {
      const root = tempRoot();
      mkdirSync(join(root, '.claude/design'), { recursive: true });
      const absolute = join(root, TOKENS_PATH);
      writeFileSync(absolute, renderTokenSeed());
      chmodSync(absolute, 0o000);

      const result = checkDesignTokens(ctxAt(root));

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.level).toBe('WARN');
      expect(result.findings[0]?.msg).toContain('could not be read');
    },
  );

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

describe('checkStaleTokenSeed', () => {
  it('treats a missing token file as the expected state rather than a warning', () => {
    const result = checkStaleTokenSeed(ctxAt(tempRoot()));

    expect(result.findings).toHaveLength(0);
    expect(result.readouts).toEqual([
      'design: token source is the Tailwind theme, so no token file is expected',
    ]);
  });

  it('warns that a leftover token file is unread and will never be deleted for you', () => {
    const root = tempRoot();
    mkdirSync(join(root, '.claude/design'), { recursive: true });
    writeFileSync(join(root, TOKENS_PATH), renderTokenSeed());

    const result = checkStaleTokenSeed(ctxAt(root));

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.level).toBe('WARN');
    expect(result.findings[0]?.msg).toContain('nothing reads it now');
    expect(result.readouts).toHaveLength(0);
  });
});
