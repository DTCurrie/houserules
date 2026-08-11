import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { Action } from '@agent-kit/api';
import type { PayloadImports } from '../../payload-imports.js';
import { deriveLibActions } from '../copy-actions.js';

const payloadPackageJson = createRequire(import.meta.url).resolve(
  '@agent-kit/payload/package.json',
);
const payloadLibPath = (name: string) =>
  join(dirname(payloadPackageJson), 'payload-dist', 'scripts', 'lib', name);

function copyAction(module: string, dest: string): Action {
  return {
    kind: 'copy',
    src: `/plugin/payload-dist/${dest.replace('.claude/', '')}`,
    dest,
    module,
    reason: 'fixture',
  };
}

describe('deriveLibActions', () => {
  it('plans a copy of the lib a script imports, sourced from @agent-kit/payload', () => {
    const actions = [copyAction('libs', '.claude/scripts/consumer.mjs')];
    const sidecar: PayloadImports = {
      version: 1,
      libs: { 'scripts/consumer.mjs': ['entry-ledger.mjs'] },
    };

    expect(deriveLibActions(actions, sidecar, 'fixture-plugin')).toEqual([
      {
        kind: 'copy',
        src: payloadLibPath('entry-ledger.mjs'),
        dest: '.claude/scripts/lib/entry-ledger.mjs',
        module: 'libs',
        reason: 'shared script library',
      },
    ]);
  });

  it('plans one copy when two actions in the same call import the same lib', () => {
    const actions = [
      copyAction('libs', '.claude/scripts/consumer.mjs'),
      copyAction('libs', '.claude/scripts/consumer2.mjs'),
    ];
    const sidecar: PayloadImports = {
      version: 1,
      libs: {
        'scripts/consumer.mjs': ['entry-ledger.mjs'],
        'scripts/consumer2.mjs': ['entry-ledger.mjs'],
      },
    };

    expect(deriveLibActions(actions, sidecar, 'fixture-plugin')).toHaveLength(
      1,
    );
  });

  it('plans nothing for an action whose dest has no entry in the sidecar', () => {
    const actions = [copyAction('libs', '.claude/scripts/lonely.mjs')];
    const sidecar: PayloadImports = {
      version: 1,
      libs: { 'scripts/consumer.mjs': ['entry-ledger.mjs'] },
    };

    expect(deriveLibActions(actions, sidecar, 'fixture-plugin')).toEqual([]);
  });

  it('plans nothing when the sidecar is empty', () => {
    const actions = [copyAction('libs', '.claude/scripts/consumer.mjs')];
    const sidecar: PayloadImports = { version: 1, libs: {} };

    expect(deriveLibActions(actions, sidecar, 'fixture-plugin')).toEqual([]);
  });

  it('ignores non-copy actions', () => {
    const actions: Action[] = [
      {
        kind: 'write',
        module: 'libs',
        dest: '.claude/scripts/consumer.mjs',
        content: 'irrelevant',
        reason: 'fixture',
      },
    ];
    const sidecar: PayloadImports = {
      version: 1,
      libs: { 'scripts/consumer.mjs': ['entry-ledger.mjs'] },
    };

    expect(deriveLibActions(actions, sidecar, 'fixture-plugin')).toEqual([]);
  });

  it('throws naming the plugin and the sidecar file when a named lib does not exist in @agent-kit/payload', () => {
    const actions = [copyAction('bad-lib', '.claude/scripts/consumer.mjs')];
    const sidecar: PayloadImports = {
      version: 1,
      libs: { 'scripts/consumer.mjs': ['nonexistent-lib.mjs'] },
    };

    expect(() => deriveLibActions(actions, sidecar, 'my-plugin')).toThrowError(
      /my-plugin/,
    );
    expect(() => deriveLibActions(actions, sidecar, 'my-plugin')).toThrowError(
      /payload-imports\.json/,
    );
  });
});
