import { describe, expect, it } from 'vitest';

import {
  renderChangesetConfig,
  renderClaudeAdditions,
  renderClaudeMd,
  renderHouseConfig,
  renderReviewerDraft,
  schemaRefFor,
  verifyDefaultsFor,
} from '../render.js';
import type { PackageManagerInfo } from '../detect.js';
import { parseHouseConfig } from '@houserules/api/internal';
import { makeAnswers, makeCtx, makeTarget } from '#test/ctx-builder';

describe('verifyDefaultsFor', () => {
  it('sets commands to just "verify" regardless of package manager', () => {
    const pm: PackageManagerInfo = { name: 'pnpm', source: 'lockfile' };
    expect(verifyDefaultsFor(pm).commands).toEqual(['verify']);
  });

  it('uses npm as the runner when the package manager is unknown', () => {
    expect(verifyDefaultsFor(null).runner).toBe('npm');
  });

  it('uses the workspace filter flag for yarn', () => {
    const pm: PackageManagerInfo = { name: 'yarn', source: 'lockfile' };
    expect(verifyDefaultsFor(pm, true).filterFlag).toBe('workspace');
  });

  it('clears the filter flag for a single-package repo', () => {
    const pm: PackageManagerInfo = { name: 'pnpm', source: 'lockfile' };
    expect(verifyDefaultsFor(pm, false).filterFlag).toBe('');
  });
});

describe('schemaRefFor', () => {
  it('points at the local node_modules copy when @houserules/cli is a dependency', () => {
    const ctx = makeCtx({
      rootPkg: {
        name: 'my-repo',
        dependencies: { '@houserules/cli': '^1.0.0' },
      },
    });
    expect(schemaRefFor(ctx)).toBe(
      '../node_modules/@houserules/cli/schema/houserules.config.schema.json',
    );
  });

  it('points at the local node_modules copy when @houserules/cli is a devDependency', () => {
    const ctx = makeCtx({
      rootPkg: {
        name: 'my-repo',
        devDependencies: { '@houserules/cli': '^1.0.0' },
      },
    });
    expect(schemaRefFor(ctx)).toBe(
      '../node_modules/@houserules/cli/schema/houserules.config.schema.json',
    );
  });

  it('falls back to the published URL when @houserules/cli is not a dependency', () => {
    const ctx = makeCtx({
      rootPkg: { name: 'my-repo', dependencies: { react: '^18.0.0' } },
    });
    expect(schemaRefFor(ctx)).toBe(
      'https://github.com/DTCurrie/houserules/blob/main/schema/houserules.config.schema.json',
    );
  });

  it('falls back to the published URL when there is no root package.json', () => {
    const ctx = makeCtx({ rootPkg: null });
    expect(schemaRefFor(ctx)).toBe(
      'https://github.com/DTCurrie/houserules/blob/main/schema/houserules.config.schema.json',
    );
  });
});

describe('renderHouseConfig', () => {
  it('reports npm as the package manager when detection found none', () => {
    const ctx = makeCtx({ packageManager: null });
    const config = JSON.parse(renderHouseConfig(ctx, makeAnswers()));
    expect(config.packageManager).toBe('npm');
  });

  it('reports the detected package manager', () => {
    const ctx = makeCtx({
      packageManager: { name: 'pnpm', source: 'lockfile' },
    });
    const config = JSON.parse(renderHouseConfig(ctx, makeAnswers()));
    expect(config.packageManager).toBe('pnpm');
  });

  it('omits the verify block when the verify-changed module is not selected', () => {
    const ctx = makeCtx();
    const config = JSON.parse(
      renderHouseConfig(ctx, makeAnswers({ moduleIds: ['core'] })),
    );
    expect(config.verify).toBeUndefined();
  });

  it('includes the verify block when the verify-changed module is selected', () => {
    const ctx = makeCtx();
    const config = JSON.parse(
      renderHouseConfig(
        ctx,
        makeAnswers({ moduleIds: ['core', 'verify-changed'] }),
      ),
    );
    expect(config.verify.commands).toEqual(['verify']);
  });

  it('enables changesets in the config when the changesets module is selected', () => {
    const ctx = makeCtx();
    const config = JSON.parse(
      renderHouseConfig(
        ctx,
        makeAnswers({ moduleIds: ['core', 'changesets'] }),
      ),
    );
    expect(config.changesets).toEqual({
      enabled: true,
      stopCheck: true,
      baseBranch: 'main',
    });
  });

  it('disables changesets in the config when the changesets module is not selected', () => {
    const ctx = makeCtx();
    const config = JSON.parse(
      renderHouseConfig(ctx, makeAnswers({ moduleIds: ['core'] })),
    );
    expect(config.changesets).toEqual({
      enabled: false,
      stopCheck: false,
      baseBranch: 'main',
    });
  });

  it('adds a changelogPath and logPath per target when the ledger module is selected', () => {
    const ctx = makeCtx();
    const config = JSON.parse(
      renderHouseConfig(
        ctx,
        makeAnswers({
          moduleIds: ['core', 'ledger'],
          targets: [makeTarget({ name: 'web' })],
        }),
      ),
    );
    expect(config.targets[0]).toMatchObject({
      changelogPath: '.claude/changelogs/web.md',
      logPath: '.claude/changelogs/web.log',
    });
  });

  it('omits changelogPath and logPath per target when the ledger module is not selected', () => {
    const ctx = makeCtx();
    const config = JSON.parse(
      renderHouseConfig(ctx, makeAnswers({ moduleIds: ['core'] })),
    );
    expect(config.targets[0].changelogPath).toBeUndefined();
  });

  it('carries a target fixCommands override into the rendered target', () => {
    const ctx = makeCtx();
    const config = JSON.parse(
      renderHouseConfig(
        ctx,
        makeAnswers({
          targets: [makeTarget({ fixCommands: ['custom:fix'] })],
        }),
      ),
    );
    expect(config.targets[0].fixCommands).toEqual(['custom:fix']);
  });

  it('produces one target entry per answer target', () => {
    const ctx = makeCtx();
    const config = JSON.parse(
      renderHouseConfig(
        ctx,
        makeAnswers({
          targets: [makeTarget({ name: 'a' }), makeTarget({ name: 'b' })],
        }),
      ),
    );
    expect(config.targets.map((t: { name: string }) => t.name)).toEqual([
      'a',
      'b',
    ]);
  });

  it('ends with a trailing newline', () => {
    const ctx = makeCtx();
    expect(renderHouseConfig(ctx, makeAnswers())).toMatch(/\n$/);
  });

  it('persists chosen module options and round-trips through the config schema', () => {
    const ctx = makeCtx();
    const rendered = renderHouseConfig(
      ctx,
      makeAnswers({ moduleOptions: { testing: ['python', 'go'] } }),
    );
    const parsed = parseHouseConfig(rendered);
    expect(parsed.moduleOptions).toEqual({ testing: ['python', 'go'] });
  });

  it('omits the moduleOptions key when no module has chosen options', () => {
    const ctx = makeCtx();
    const config = JSON.parse(
      renderHouseConfig(ctx, makeAnswers({ moduleOptions: {} })),
    );
    expect(config.moduleOptions).toBeUndefined();
  });
});

describe('renderReviewerDraft', () => {
  it('marks the draft in the description', () => {
    const draft = renderReviewerDraft(makeTarget({ label: 'Core' }));
    expect(draft).toMatch(/description: "DRAFT:/);
  });

  it('names the agent after the target', () => {
    const draft = renderReviewerDraft(makeTarget({ name: 'web' }));
    expect(draft).toMatch(/name: "web-reviewer"/);
  });

  it('includes the target label in the body', () => {
    const draft = renderReviewerDraft(makeTarget({ label: 'Web frontend' }));
    expect(draft).toMatch(/Web frontend reviewer/);
  });

  it('shows the repo root marker when pathPrefix is empty', () => {
    const draft = renderReviewerDraft(makeTarget({ pathPrefix: '' }));
    expect(draft).toMatch(/`\.\/`/);
  });
});

describe('renderChangesetConfig', () => {
  it('uses the detected git branch as the base branch', () => {
    const ctx = makeCtx({
      git: { isRepo: true, top: '/repo', hasCommits: true, branch: 'develop' },
    });
    const config = JSON.parse(renderChangesetConfig(ctx));
    expect(config.baseBranch).toBe('develop');
  });

  it('falls back to main when the branch is detached HEAD', () => {
    const ctx = makeCtx({
      git: { isRepo: true, top: '/repo', hasCommits: true, branch: 'HEAD' },
    });
    const config = JSON.parse(renderChangesetConfig(ctx));
    expect(config.baseBranch).toBe('main');
  });

  it('falls back to main when there is no branch at all', () => {
    const ctx = makeCtx({
      git: { isRepo: false, top: null, hasCommits: false, branch: null },
    });
    const config = JSON.parse(renderChangesetConfig(ctx));
    expect(config.baseBranch).toBe('main');
  });
});

describe('renderClaudeAdditions', () => {
  it('omits the changesets section when the changesets module is not selected', () => {
    const ctx = makeCtx();
    const body = renderClaudeAdditions(
      ctx,
      makeAnswers({ moduleIds: ['core'] }),
    );
    expect(body).not.toMatch(/Recording changes \(changesets\)/);
  });

  it('includes the changesets section when the changesets module is selected', () => {
    const ctx = makeCtx();
    const body = renderClaudeAdditions(
      ctx,
      makeAnswers({ moduleIds: ['core', 'changesets'] }),
    );
    expect(body).toMatch(/Recording changes \(changesets\)/);
  });

  it('lists the backlog prefix for each target when the backlog module is selected', () => {
    const ctx = makeCtx();
    const body = renderClaudeAdditions(
      ctx,
      makeAnswers({
        moduleIds: ['core', 'backlog'],
        targets: [makeTarget({ prefix: 'WEB', pathPrefix: 'apps/web/' })],
      }),
    );
    expect(body).toMatch(/`WEB` \(apps\/web\/\)/);
  });

  it('omits the orchestrate exception line when orchestrate is not selected', () => {
    const ctx = makeCtx();
    const body = renderClaudeAdditions(
      ctx,
      makeAnswers({ moduleIds: ['core'] }),
    );
    expect(body).not.toMatch(/planned phase under `\/orchestrate`/);
  });

  it('includes the orchestrate exception line when orchestrate is selected', () => {
    const ctx = makeCtx();
    const body = renderClaudeAdditions(
      ctx,
      makeAnswers({ moduleIds: ['core', 'orchestrate'] }),
    );
    expect(body).toMatch(/planned phase under `\/orchestrate`/);
  });

  it('orders the verify gates so autofix runs before typecheck and test', () => {
    const body = renderClaudeAdditions(makeCtx(), makeAnswers());

    expect(body).toMatch(/format first/);
    expect(body).toMatch(/lint with autofix/);
    expect(body.indexOf('format first')).toBeLessThan(
      body.indexOf('typecheck and test'),
    );
  });

  it('states that done means every check passed', () => {
    const body = renderClaudeAdditions(makeCtx(), makeAnswers());

    expect(body).toMatch(/"Done" means every check passed/);
  });

  it('says the verify gates once, so the two bullets do not restate each other', () => {
    const body = renderClaudeAdditions(makeCtx(), makeAnswers());

    expect(body.match(/static gates/g)).toHaveLength(1);
  });

  it('tells the agent to re-read a file whose view is second-hand before editing', () => {
    const body = renderClaudeAdditions(makeCtx(), makeAnswers());

    expect(body).toMatch(/Re-read before editing/);
    expect(body).toMatch(/second-hand/);
  });

  it('tells the agent to surface a problem in the user own work rather than fix it silently', () => {
    const body = renderClaudeAdditions(makeCtx(), makeAnswers());

    expect(body).toMatch(/Do not rewrite what is not yours to change/);
  });
});

describe('renderClaudeMd', () => {
  it('uses the root package name as the heading', () => {
    const ctx = makeCtx({ rootPkg: { name: 'widget-factory' } });
    const md = renderClaudeMd(ctx, makeAnswers());
    expect(md).toMatch(/^# widget-factory/);
  });

  it('falls back to "this repo" as the heading when there is no root package.json', () => {
    const ctx = makeCtx({ rootPkg: null });
    const md = renderClaudeMd(ctx, makeAnswers());
    expect(md).toMatch(/^# this repo/);
  });

  it('lists every target under the Layout section', () => {
    const ctx = makeCtx();
    const md = renderClaudeMd(
      ctx,
      makeAnswers({
        targets: [
          makeTarget({
            name: 'web',
            pathPrefix: 'apps/web/',
            label: 'Web app',
          }),
        ],
      }),
    );
    expect(md).toMatch(/`apps\/web\/`: Web app/);
  });

  it('lists a script line only for scripts present in package.json', () => {
    const ctx = makeCtx({
      rootPkg: { name: 'my-repo', scripts: { test: 'vitest', dev: 'vite' } },
    });
    const md = renderClaudeMd(ctx, makeAnswers());
    expect(md).toMatch(/`npm run test`/);
    expect(md).toMatch(/`npm run dev`/);
    expect(md).not.toMatch(/`npm run lint`/);
  });

  it('emits exactly one start marker and one end marker', () => {
    const ctx = makeCtx();
    const md = renderClaudeMd(ctx, makeAnswers());
    const starts = md.match(/<!-- houserules:claude-md start -->/g) ?? [];
    const ends = md.match(/<!-- houserules:claude-md end -->/g) ?? [];
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
  });

  it('places the start marker before the end marker', () => {
    const ctx = makeCtx();
    const md = renderClaudeMd(ctx, makeAnswers());
    expect(md.indexOf('<!-- houserules:claude-md start -->')).toBeLessThan(
      md.indexOf('<!-- houserules:claude-md end -->'),
    );
  });

  it('embeds the same additions body between the markers', () => {
    const ctx = makeCtx();
    const answers = makeAnswers({ moduleIds: ['core', 'changesets'] });
    const md = renderClaudeMd(ctx, answers);
    const additions = renderClaudeAdditions(ctx, answers).trimEnd();
    const start = md.indexOf('<!-- houserules:claude-md start -->');
    const end = md.indexOf('<!-- houserules:claude-md end -->');
    const between = md.slice(start, end);
    expect(between).toContain(additions);
  });
});
