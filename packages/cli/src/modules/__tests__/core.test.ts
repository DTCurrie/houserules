import { describe, expect, it } from 'vitest';

import { makeAnswers, makeCtx } from '#test/ctx-builder';
import type { HouseConfig } from '@houserules/api';
import { plan } from '../core.js';

describe('core plan, the merged Bash gate', () => {
  it('ships no separate subagent-write-gate.mjs script or hook, its checks live in guard-bash.mjs', () => {
    const actions = plan(makeCtx(), makeAnswers());

    expect(JSON.stringify(actions).includes('subagent-write-gate.mjs')).toBe(
      false,
    );
  });

  it('wires guard-bash.mjs as the single PreToolUse(Bash) hook', () => {
    const actions = plan(makeCtx(), makeAnswers());

    const bashHookCommands = actions
      .filter(
        (a): a is Extract<typeof a, { kind: 'merge-settings' }> =>
          a.kind === 'merge-settings',
      )
      .flatMap((a) => a.fragment.hooks?.PreToolUse ?? [])
      .filter((group) => group.matcher === 'Bash')
      .flatMap((group) => group.hooks.map((h) => h.command));

    expect(bashHookCommands).toHaveLength(1);
    expect(bashHookCommands[0]).toContain('guard-bash.mjs');
  });
});

describe('core plan, the ledger directory .gitignore', () => {
  function ctxWithLedgerConsumer(): ReturnType<typeof makeCtx> {
    const ctx = makeCtx();
    ctx.claude.houseConfig = {
      plugins: [{ name: '@houserules/plugin-backlog', alias: 'backlog' }],
    } as unknown as HouseConfig;
    return ctx;
  }

  function plannedLedgerIgnore(
    ctx: ReturnType<typeof makeCtx>,
  ): Extract<ReturnType<typeof plan>[number], { kind: 'write' }> | undefined {
    return plan(ctx, makeAnswers()).find(
      (a): a is Extract<typeof a, { kind: 'write' }> =>
        a.kind === 'write' &&
        a.reason ===
          'the ledger directory is a local push queue. GitHub Projects is the durable record',
    );
  }

  function ledgerIgnoreContent(): string {
    const action = plannedLedgerIgnore(ctxWithLedgerConsumer());
    if (!action) throw new Error('no ledger .gitignore action planned');
    return action.content;
  }

  it('is not planned when no ledger-consuming plugin is configured', () => {
    expect(plannedLedgerIgnore(makeCtx())).toBe(undefined);
  });

  it('is not planned when only non-ledger plugins are configured', () => {
    const ctx = makeCtx();
    ctx.claude.houseConfig = {
      plugins: [{ name: '@houserules/plugin-typescript', alias: 'ts' }],
    } as unknown as HouseConfig;

    expect(plannedLedgerIgnore(ctx)).toBe(undefined);
  });

  it('is planned when a ledger-consuming plugin is wired by repo-relative path', () => {
    const ctx = makeCtx();
    ctx.claude.houseConfig = {
      plugins: [{ name: 'packages/plugin-decisions', alias: 'decisions' }],
    } as unknown as HouseConfig;

    expect(plannedLedgerIgnore(ctx)?.dest).toBe('.claude/ledgers/.gitignore');
  });

  it('is planned when ledgers.dir is set explicitly, with no plugin at all', () => {
    const ctx = makeCtx();
    ctx.claude.houseConfig = {
      ledgers: { dir: 'docs/ledgers' },
    } as unknown as HouseConfig;

    expect(plannedLedgerIgnore(ctx)?.dest).toBe('docs/ledgers/.gitignore');
  });

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
    ctx.claude.houseConfig = {
      ledgers: { dir: '../outside' },
    } as unknown as HouseConfig;

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
