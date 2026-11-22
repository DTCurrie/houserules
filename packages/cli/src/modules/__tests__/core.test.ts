import { describe, expect, it } from 'vitest';

import { makeAnswers, makeCtx, makeRegistry } from '#test/ctx-builder';
import { hookCommand } from '@houserules/api';
import type { HouseConfig, RegionAction } from '@houserules/api';
import { upsertRegion } from '@houserules/api/internal';
import { plan } from '../core.js';
import { buildPlan, MODULES } from '../../plan.js';

describe('core plan, the merged Bash gate', () => {
  it('ships no separate subagent-write-gate.mjs script or hook, its checks live in guard-bash.mjs', () => {
    const actions = plan(makeCtx(), makeAnswers());

    expect(JSON.stringify(actions)).not.toContain('subagent-write-gate.mjs');
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

describe('core plan, hook failure mode', () => {
  function hookFor(script: string): Record<string, unknown> | undefined {
    return plan(makeCtx(), makeAnswers())
      .filter(
        (a): a is Extract<typeof a, { kind: 'merge-settings' }> =>
          a.kind === 'merge-settings',
      )
      .flatMap((a) => Object.values(a.fragment.hooks ?? {}).flat())
      .flatMap((group) => group.hooks)
      .find((h) => h.command.includes(script));
  }

  it('fails closed on the guard-bash hook', () => {
    expect(hookFor('guard-bash.mjs')?.onFailure).toBe('block');
  });

  it('leaves the ledger-inject hook without onFailure', () => {
    const hook = hookFor('ledger-inject.mjs');
    expect(hook).toBeDefined();
    expect('onFailure' in hook!).toBe(false);
  });
});

describe('core plan, the payload-sync hook', () => {
  it('wires payload-sync.mjs on SessionStart with the bootstrap command', () => {
    const commands = plan(makeCtx(), makeAnswers())
      .filter(
        (a): a is Extract<typeof a, { kind: 'merge-settings' }> =>
          a.kind === 'merge-settings',
      )
      .flatMap((a) => a.fragment.hooks?.SessionStart ?? [])
      .flatMap((group) => group.hooks.map((h) => h.command));

    expect(commands).toContain(hookCommand('payload-sync.mjs', 'bootstrap'));
  });

  it('copies payload-sync.mjs into the install', () => {
    const copied = plan(makeCtx(), makeAnswers()).filter(
      (a) => a.kind === 'copy' && a.dest.endsWith('scripts/payload-sync.mjs'),
    );

    expect(copied).toHaveLength(1);
  });

  it('copies version-check.mjs without wiring a hook for it', () => {
    const actions = plan(makeCtx(), makeAnswers());
    const copied = actions.filter(
      (a) => a.kind === 'copy' && a.dest.endsWith('scripts/version-check.mjs'),
    );
    const commands = JSON.stringify(
      actions.filter((a) => a.kind === 'merge-settings'),
    );

    expect(copied).toHaveLength(1);
    expect(commands).not.toContain('version-check');
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
      actions.filter(
        (a) =>
          a.kind === 'write' &&
          a.reason ===
            'the ledger directory is a local push queue. GitHub Projects is the durable record',
      ),
    ).toEqual([]);
  });
});

describe('core plan, the .claude/.gitignore block over a file the user already owns', () => {
  const USER_ABOVE = '# my own ignores\n/local-notes.md\n\n';
  const USER_BELOW = '\n\n/scratch/\n!keep.me\n';

  function plannedBlock(): RegionAction {
    const blocks = buildPlan(
      makeCtx(),
      makeAnswers({ moduleIds: ['core'] }),
      makeRegistry(MODULES),
    ).filter(
      (a): a is RegionAction =>
        a.kind === 'region' && a.dest === '.claude/.gitignore',
    );
    expect(blocks).toHaveLength(1);
    return blocks[0]!;
  }

  it('keeps the user lines above and below the markers byte for byte when the block is replaced', () => {
    const block = plannedBlock();
    const staleBlock = `${block.region.start}\n/stale-entry.md\n${block.region.end}`;
    const onDisk = `${USER_ABOVE}${staleBlock}${USER_BELOW}`;

    const { content, status } = upsertRegion(onDisk, block.body, block.region);

    expect(status).toBe('replaced');
    expect(content.startsWith(USER_ABOVE)).toBe(true);
    expect(content.endsWith(USER_BELOW)).toBe(true);
    expect(content).not.toContain('/stale-entry.md');
    expect(content).toContain('/houserules.manifest.json');
    expect(content).toContain('/state/version-check.json');
  });

  it('appends the block after the user lines when the file has no markers yet', () => {
    const block = plannedBlock();
    const onDisk = '/local-notes.md\n/scratch/\n';

    const { content, status } = upsertRegion(onDisk, block.body, block.region);

    expect(status).toBe('inserted');
    expect(content.startsWith(onDisk)).toBe(true);
    expect(content).toContain(block.region.start);
  });
});
