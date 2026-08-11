import { beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { useInstalledRepo, useRepo } from '#test/repo';
import { runCli, runIn, runScript } from '#test/run';
import { editKitConfig, readJson, settingsOf } from '#test/installed-tree';
import { recordedCalls, stubRunner } from '#test/runner-stub';
import { makeAnswers, makeCtx } from '#test/ctx-builder';
import { defaultEnabled, plan } from '../lint-fix.js';

describe('lint-fix without a detected fix command', () => {
  let root: string;
  let result: ReturnType<typeof runCli>;

  beforeEach(() => {
    root = useRepo('npm-single');
    const pkgPath = join(root, 'package.json');
    const pkg = readJson(pkgPath);
    delete pkg.scripts['lint:fix'];
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    runIn(root, 'git', ['add', '-A']);
    runIn(root, 'git', ['commit', '-qm', 'drop lint:fix']);

    result = runCli(['init', '--yes', '--modules=lint-fix', root]);
  });

  it('exits 0', () => {
    expect(result.status, result.stderr).toBe(0);
  });

  it('still ships the fix script', () => {
    expect(
      existsSync(join(root, '.claude/scripts/lint-format-fix.mjs')),
    ).toBeTruthy();
  });

  it('does not wire the script into the Stop hook, since it would run a nonexistent target', () => {
    const settings = settingsOf(root);
    const stopCmds = (settings.hooks?.Stop ?? []).flatMap((g: any) =>
      g.hooks.map((h: any) => h.command),
    );
    expect(
      stopCmds.some((c: string) => c.includes('lint-format-fix.mjs')),
    ).toBeFalsy();
  });

  it('advises in stdout that no target has a detected fix command', () => {
    expect(result.stdout).toMatch(/no target has a detected fix command/);
  });

  it('does not have doctor warn about the deliberate wiring gap', () => {
    const doc = runCli(['doctor', root]);
    expect(doc.status, doc.stdout).toBe(0);
    expect(doc.stdout).not.toMatch(/lint-format-fix\.mjs not wired/);
  });
});

function stopHookScripts(actions: ReturnType<typeof plan>): string[] {
  return actions
    .filter(
      (a): a is Extract<typeof a, { kind: 'merge-settings' }> =>
        a.kind === 'merge-settings',
    )
    .flatMap((a) => a.fragment.hooks?.Stop ?? [])
    .flatMap((g) => g.hooks.map((h) => h.command));
}

describe('plan, given a root-scoped fix block whose commands are real root scripts', () => {
  it('wires the Stop hook', () => {
    const ctx = makeCtx({
      rootPkg: { name: 'my-repo', scripts: { 'lint:fix': 'eslint --fix .' } },
      targets: [],
    });
    ctx.claude.kitConfig = {
      version: 2,
      packageManager: 'npm',
      targets: [],
      fix: {
        runner: 'npm',
        filterFlag: '',
        runScriptPrefix: ['run'],
        commands: ['lint:fix'],
      },
    };

    const actions = plan(ctx, makeAnswers({ targets: [] }));

    expect(
      stopHookScripts(actions).some((c) => c.includes('lint-format-fix.mjs')),
    ).toBe(true);
  });

  it('reports defaultEnabled as true', () => {
    const ctx = makeCtx({
      rootPkg: { name: 'my-repo', scripts: { 'lint:fix': 'eslint --fix .' } },
      targets: [],
    });
    ctx.claude.kitConfig = {
      version: 2,
      packageManager: 'npm',
      targets: [],
      fix: {
        runner: 'npm',
        filterFlag: '',
        runScriptPrefix: ['run'],
        commands: ['lint:fix'],
      },
    };

    expect(defaultEnabled(ctx)).toBe(true);
  });
});

describe('plan, given a root-scoped fix block whose commands are not real root scripts', () => {
  it('does not wire the Stop hook and advises instead', () => {
    const ctx = makeCtx({
      rootPkg: { name: 'my-repo', scripts: {} },
      targets: [],
    });
    ctx.claude.kitConfig = {
      version: 2,
      packageManager: 'npm',
      targets: [],
      fix: {
        runner: 'npm',
        filterFlag: '',
        runScriptPrefix: ['run'],
        commands: ['lint:fix'],
      },
    };

    const actions = plan(ctx, makeAnswers({ targets: [] }));

    expect(
      stopHookScripts(actions).some((c) => c.includes('lint-format-fix.mjs')),
    ).toBe(false);
    expect(actions.some((a) => a.kind === 'advise')).toBe(true);
  });

  it('reports defaultEnabled as false', () => {
    const ctx = makeCtx({
      rootPkg: { name: 'my-repo', scripts: {} },
      targets: [],
    });
    ctx.claude.kitConfig = {
      version: 2,
      packageManager: 'npm',
      targets: [],
      fix: {
        runner: 'npm',
        filterFlag: '',
        runScriptPrefix: ['run'],
        commands: ['lint:fix'],
      },
    };

    expect(defaultEnabled(ctx)).toBe(false);
  });
});

describe('the per-extension fix-command gate', () => {
  const SCRIPT = '.claude/scripts/lint-format-fix.mjs';
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    stubRunner(root);
    editKitConfig(root, (c) => {
      c.fix = {
        runner: './stub-runner.sh',
        filterFlag: '--filter',
        runScriptPrefix: ['run'],
        commands: ['lint:fix', 'format:fix'],
        commandExtensions: { 'lint:fix': ['ts', 'tsx'] },
      };
      for (const t of c.targets) delete t.fixCommands;
    });
    runIn(root, 'git', ['add', '-A']);
    runIn(root, 'git', ['commit', '-qm', 'wip']);
  });

  it('skips a gated command on an edit outside its extensions, but still runs an ungated command', () => {
    writeFileSync(join(root, 'games/cityville/NOTES.md'), '# notes\n');
    const r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status, r.stderr).toBe(0);
    expect(recordedCalls(root)).toEqual(['--filter @fix/cityville format:fix']);
  });

  it('runs a gated command when the edit touches one of its extensions', () => {
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const z=1;\n',
    );
    const r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status, r.stderr).toBe(0);
    expect(recordedCalls(root).sort()).toEqual([
      '--filter @fix/cityville format:fix',
      '--filter @fix/cityville lint:fix',
    ]);
  });
});
