import { describe, expect, it } from 'vitest';

import { makeAnswers, makeCtx } from '#test/ctx-builder';
import type { KitConfig } from '../../core/config.js';
import { plan } from '../core.js';

describe('core plan, the ledger directory .gitignore', () => {
  function ledgerIgnoreContent(): string {
    const actions = plan(makeCtx(), makeAnswers());
    const action = actions.find(
      (a): a is Extract<typeof a, { kind: 'write' }> =>
        a.kind === 'write' && a.dest === '.claude/ledgers/.gitignore',
    );
    if (!action) throw new Error('no ledger .gitignore action planned');
    return action.content;
  }

  it('ignores everything in the directory except the .gitignore itself', () => {
    expect(ledgerIgnoreContent()).toBe(
      [
        '# This whole directory is local. GitHub Projects is the durable record, the .jsonl',
        '# ledgers here are a push queue drained by `projects-sync.mjs push`, and the .md',
        '# files are a rendered view. The .gitignore itself stays tracked so this rule',
        '# travels with a clone.',
        '*',
        '!.gitignore',
        '',
      ].join('\n'),
    );
  });

  it('negates .gitignore, so a bare `*` does not swallow the rule file on clone', () => {
    expect(ledgerIgnoreContent()).toMatch(/^!\.gitignore$/m);
  });

  it('plans no ledger .gitignore write when the configured dir escapes the repo', () => {
    const ctx = makeCtx();
    ctx.claude.kitConfig = {
      ledgers: { dir: '../outside' },
    } as unknown as KitConfig;

    const actions = plan(ctx, makeAnswers());

    expect(
      actions.some(
        (a) =>
          a.kind === 'write' &&
          a.reason ===
            'the ledger directory is a local push queue. GitHub Projects is the durable record',
      ),
    ).toBe(false);
  });
});
