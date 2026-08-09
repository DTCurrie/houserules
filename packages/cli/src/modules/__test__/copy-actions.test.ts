import { describe, expect, it } from 'vitest';

import type { Action } from '../../actions.js';
import { payloadPath } from '../../paths.js';
import type { PayloadImports } from '../../payload-imports.js';
import { deriveLibActions } from '../copy-actions.js';

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
  it('plans a copy of the lib a script imports, sourced from the CLI payload', () => {
    const actions = [copyAction('libs', '.claude/scripts/consumer.mjs')];
    const sidecar: PayloadImports = {
      version: 1,
      libs: { 'scripts/consumer.mjs': ['entry-ledger.mjs'] },
    };

    expect(deriveLibActions(actions, sidecar)).toEqual([
      {
        kind: 'copy',
        src: payloadPath('scripts', 'lib', 'entry-ledger.mjs'),
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

    expect(deriveLibActions(actions, sidecar)).toHaveLength(1);
  });

  it('plans nothing for an action whose dest has no entry in the sidecar', () => {
    const actions = [copyAction('libs', '.claude/scripts/lonely.mjs')];
    const sidecar: PayloadImports = {
      version: 1,
      libs: { 'scripts/consumer.mjs': ['entry-ledger.mjs'] },
    };

    expect(deriveLibActions(actions, sidecar)).toEqual([]);
  });

  it('plans nothing when the sidecar is empty', () => {
    const actions = [copyAction('libs', '.claude/scripts/consumer.mjs')];
    const sidecar: PayloadImports = { version: 1, libs: {} };

    expect(deriveLibActions(actions, sidecar)).toEqual([]);
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

    expect(deriveLibActions(actions, sidecar)).toEqual([]);
  });
});
