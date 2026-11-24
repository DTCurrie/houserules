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

  it('records the selected module ids', () => {
    const config = JSON.parse(
      renderHouseConfig(
        makeCtx(),
        makeAnswers({ moduleIds: ['core', 'read-guard'] }),
      ),
    );
    expect(config.modules).toEqual(['core', 'read-guard']);
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
  const guardCtx = (guard: Record<string, boolean>) => {
    const base = makeCtx();
    return makeCtx({
      claude: {
        ...base.claude,
        houseConfig: { guard } as unknown as typeof base.claude.houseConfig,
      },
    });
  };
  const opening = '- **The user always handles';
  const ownershipLineOf = (body: string) =>
    body.split('\n').find((line) => line.startsWith('Maintained by'));

  it('keeps the full commit rule when there is no guard config', () => {
    const body = renderClaudeAdditions(makeCtx(), makeAnswers());
    expect(body).toContain(
      '- **The user always handles `git commit` / `push` / PR-create.** Describe what is ready and stop.',
    );
  });

  it('drops git commit from the rule when gitCommit is off', () => {
    const body = renderClaudeAdditions(
      guardCtx({ gitCommit: false }),
      makeAnswers(),
    );
    expect(body).toContain(
      '- **The user always handles `git push` / PR-create.** Describe what is ready and stop.',
    );
  });

  it('drops git push from the rule when gitPush is off', () => {
    const body = renderClaudeAdditions(
      guardCtx({ gitPush: false }),
      makeAnswers(),
    );
    expect(body).toContain(
      '- **The user always handles `git commit` / PR-create.** Describe what is ready and stop.',
    );
  });

  it('omits the rule, leaving no blank line, when all three flags are off', () => {
    const body = renderClaudeAdditions(
      guardCtx({ gitCommit: false, gitPush: false, prCreate: false }),
      makeAnswers(),
    );
    expect(body).not.toContain(opening);
    expect(body).not.toMatch(/\n\n\n/);
    expect(body).toContain(
      "### Conventions\n\n- **Edit from the file's current bytes.**",
    );
  });

  it('renders no Skill triggers section when no skill-shipping module is selected', () => {
    const ctx = makeCtx();
    const body = renderClaudeAdditions(
      ctx,
      makeAnswers({ moduleIds: ['core'] }),
    );
    expect(body).not.toMatch(/### Skill triggers/);
    expect(body).not.toMatch(/\/changeset/);
  });

  it('renders the changeset trigger when the changesets module is selected', () => {
    const ctx = makeCtx();
    const body = renderClaudeAdditions(
      ctx,
      makeAnswers({ moduleIds: ['core', 'changesets'] }),
    );
    expect(body).toMatch(/### Skill triggers/);
    expect(body).toMatch(/record a changeset with `\/changeset`/);
  });

  it('renders contributed trigger lines after the ledger-ids bullet', () => {
    const ctx = makeCtx();
    const body = renderClaudeAdditions(
      ctx,
      makeAnswers({
        moduleIds: ['core', 'backlog'],
        contributedSkillTriggers: [
          '- Contributed first line',
          '  second line.',
        ],
      }),
    );
    expect(body).toContain(
      '- Discovered a real issue outside the current scope? **Do not fix it inline.** Log it with\n  `/backlog-add`.\n- Ledger ids stay in the ledger, never in code, docs, changesets, commit messages, or issues.\n- Contributed first line\n  second line.\n',
    );
  });

  it('renders the Skill triggers heading when the only bullets are contributed', () => {
    const ctx = makeCtx();
    const body = renderClaudeAdditions(
      ctx,
      makeAnswers({
        moduleIds: ['core'],
        contributedSkillTriggers: ['- Only contributed.'],
      }),
    );
    expect(body).toContain('### Skill triggers\n\n- Only contributed.\n');
  });

  it('renders no design text when no lines are contributed, even with a design module id selected', () => {
    const ctx = makeCtx();
    const body = renderClaudeAdditions(
      ctx,
      makeAnswers({ moduleIds: ['core', 'design', 'ui/design-tailwind'] }),
    );
    expect(body).not.toContain('Building UI');
    expect(body).not.toContain('### Skill triggers');
  });

  it('renders the backlog trigger without listing target prefixes', () => {
    const ctx = makeCtx();
    const body = renderClaudeAdditions(
      ctx,
      makeAnswers({
        moduleIds: ['core', 'backlog'],
        targets: [makeTarget({ prefix: 'WEB', pathPrefix: 'apps/web/' })],
      }),
    );
    expect(body).toMatch(/Do not fix it inline/);
    expect(body).not.toMatch(/`WEB`/);
  });

  it('states the ledger-id prohibition once when both ledger modules are selected', () => {
    const ctx = makeCtx();
    const body = renderClaudeAdditions(
      ctx,
      makeAnswers({ moduleIds: ['core', 'backlog', 'decisions'] }),
    );
    expect(body.match(/stay in the ledger/g)).toHaveLength(1);
  });

  it('omits the ledger-id prohibition when neither ledger module is selected', () => {
    const ctx = makeCtx();
    const body = renderClaudeAdditions(
      ctx,
      makeAnswers({ moduleIds: ['core', 'changesets'] }),
    );
    expect(body).not.toMatch(/stay in the ledger/);
  });

  it('combines plan-project and orchestrate into one trigger when both are selected', () => {
    const ctx = makeCtx();
    const body = renderClaudeAdditions(
      ctx,
      makeAnswers({ moduleIds: ['core', 'plans', 'orchestrate'] }),
    );
    expect(body).toMatch(
      /scaffold with `\/plan-project`, then execute each phase with/,
    );
  });

  it('renders a plan-project trigger without orchestrate when plans is selected alone', () => {
    const ctx = makeCtx();
    const body = renderClaudeAdditions(
      ctx,
      makeAnswers({ moduleIds: ['core', 'plans'] }),
    );
    expect(body).toMatch(/scaffold it with `\/plan-project`/);
    expect(body).not.toMatch(/\/orchestrate/);
  });

  it('omits the orchestrate exception line when orchestrate is not selected', () => {
    const ctx = makeCtx();
    const body = renderClaudeAdditions(
      ctx,
      makeAnswers({ moduleIds: ['core'] }),
    );
    expect(body).not.toMatch(/planned phase under `\/orchestrate`/);
  });

  it('includes the orchestrate exception line, deferring dispatch to the skill, when orchestrate is selected', () => {
    const ctx = makeCtx();
    const body = renderClaudeAdditions(
      ctx,
      makeAnswers({ moduleIds: ['core', 'orchestrate'] }),
    );
    expect(body).toContain(
      '- Exception, a planned phase under `/orchestrate`: dispatch as that skill says. Never pull a\n  worker’s diff into the main context.',
    );
  });

  it('names the CLAUDE.md markers as the boundary in the import target, which has none of its own', () => {
    const body = renderClaudeAdditions(makeCtx(), makeAnswers());

    expect(ownershipLineOf(body)).toBe(
      'Maintained by `npx houserules update`, which rewrites this whole file. `CLAUDE.md` imports it between the houserules markers, and text outside those markers is yours and never touched.',
    );
  });

  it('keeps the marker sentence in an AGENTS.md region', () => {
    const base = makeCtx();
    const ctx = makeCtx({
      claude: { ...base.claude, instructionsFile: 'AGENTS.md' },
    });

    const body = renderClaudeAdditions(ctx, makeAnswers());

    expect(ownershipLineOf(body)).toBe(
      'Maintained by `npx houserules update`. Text outside the markers is yours and never touched.',
    );
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

  it('tells the agent a missing [houserules] SessionStart banner means hooks are inactive', () => {
    const body = renderClaudeAdditions(makeCtx(), makeAnswers());

    expect(body).toMatch(/missing `\[houserules\]` SessionStart banner/);
    expect(body).toMatch(
      /installed hooks, including the Bash guard, are not active/,
    );
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

  it('nests each recorded evasion under the done bullet with its answer', () => {
    const body = renderClaudeAdditions(makeCtx(), makeAnswers());
    expect(body).toContain(
      [
        '  or never ran, with its output. The recorded evasions, and what each one means:',
        '  - "The edits are in, so it is done": done is the checks passing, with output you read.',
        '  - "I know this fact from memory": a fact from training data or an earlier session is a guess',
        '    until a command confirms it. A fact this session already observed, on files unchanged since,',
        '    is evidence. Cite where you saw it instead of re-running, since a re-run costs wall time and',
        '    finds nothing new.',
        '  - "It passed earlier": a pass is stale only when a file it covers changed after it ran. A',
        '    content-hash skip on unchanged inputs is a pass. It proves nothing about a file outside the',
        "    script's declared inputs.",
        '  - "The subagent reported success": check the tree, meaning `git status` and',
        "    `git diff --name-only` against the slice's owned paths. The acceptance output in the report",
        '    is the evidence. Re-run an acceptance only when its output is missing, could be a cache skip',
        '    outside the declared inputs, or you can name the doubt.',
        '  - "The draft might be wrong": an artifact that already passed a review round is edited where',
        '    it changes, not re-verified claim by claim.',
        '  - "Let me confirm first": when the user asked for an action that is cheap to reverse and its',
        '    content is ready, take it, then check the result once. Before it, at most one check, and only',
        '    for a claim you can name a doubt about. Cheap to reverse: editing a pull request or issue',
        '    body, a local edit under version control, a re-runnable command with no effect outside the',
        '    repo. Not cheap: a push, a publish, a merge, a delete, or a message to another person.',
        '- Derive empirical constants by parsing the artifact itself, not screenshot-and-iterate loops.',
      ].join('\n'),
    );
  });

  it('tells a subagent to background a command that outlasts the default Bash timeout', () => {
    const body = renderClaudeAdditions(makeCtx(), makeAnswers());
    expect(body).toContain(
      '`run_in_background: true`, ends its turn without reporting',
    );
    expect(body).toContain(
      'A foreground call blocks the\n  subagent until Claude Code moves it to the background anyway, so starting it there saves the\n  blocked minutes and lets the subagent end its turn.',
    );
  });

  it('tells a subagent to run a command that finishes inside the default Bash timeout in the foreground', () => {
    const body = renderClaudeAdditions(makeCtx(), makeAnswers());

    expect(body).toContain(
      'A command expected to finish inside the\n  default Bash timeout, such as a scoped test or typecheck, runs in the foreground.',
    );
  });

  it('gives the backgrounding reason without claiming the harness aborts the subagent', () => {
    const body = renderClaudeAdditions(makeCtx(), makeAnswers());
    expect(body).not.toMatch(/aborted|CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS/);
  });

  it('caps checks before a requested file', () => {
    const body = renderClaudeAdditions(makeCtx(), makeAnswers());
    expect(body.split('first version').length - 1).toBe(1);
  });

  it('tells the agent to call command grep for ignored paths', () => {
    const body = renderClaudeAdditions(makeCtx(), makeAnswers());
    expect(body.split('command grep').length - 1).toBe(1);
  });

  it('names the ignored-directory example outside inline code, so doctor reads no path reference', () => {
    const body = renderClaudeAdditions(makeCtx(), makeAnswers());
    expect(body).toContain('such as .claude/plans.');
    expect(body).not.toContain('`.claude/plans`');
  });

  it('embeds only the import line between the markers of a seeded CLAUDE.md', () => {
    const answers = makeAnswers({ moduleIds: ['core', 'changesets'] });
    const md = renderClaudeMd(makeCtx(), answers);
    const start = md.indexOf('<!-- houserules:claude-md start -->');
    const end = md.indexOf('<!-- houserules:claude-md end -->');
    const between = md.slice(start, end);
    expect(between).toContain('@.claude/houserules.md');
    expect(between).not.toContain('### houserules sections');
  });

  it('embeds the full additions body between the markers of a seeded AGENTS.md', () => {
    const base = makeCtx();
    const ctx = makeCtx({
      claude: { ...base.claude, instructionsFile: 'AGENTS.md' },
    });
    const answers = makeAnswers({ moduleIds: ['core', 'changesets'] });
    const md = renderClaudeMd(ctx, answers);
    const additions = renderClaudeAdditions(ctx, answers).trimEnd();
    const start = md.indexOf('<!-- houserules:claude-md start -->');
    const end = md.indexOf('<!-- houserules:claude-md end -->');
    expect(md.slice(start, end)).toContain(additions);
  });
});

describe('passPaths default: today', () => {
  const pnpm: PackageManagerInfo = { name: 'pnpm', source: 'lockfile' };
  const detected = ['lint:fix', 'format'];
  const answers = (fixCommands?: string[]) =>
    makeAnswers({
      moduleIds: ['core', 'lint-fix'],
      targets: [makeTarget(fixCommands ? { fixCommands } : {})],
    });
  const seededFix = {
    runner: 'pnpm',
    filterFlag: '',
    runScriptPrefix: ['run'],
    commands: ['lint:fix', 'format:fix'],
    onSubagentStop: false,
  };

  it('seeds the fix block without passPaths for whole-tree scripts in a single-package pnpm repo', () => {
    const ctx = makeCtx({
      packageManager: pnpm,
      rootPkg: {
        name: 'my-repo',
        scripts: { 'lint:fix': 'eslint . --fix', format: 'prettier --write .' },
      },
    });
    const config = JSON.parse(renderHouseConfig(ctx, answers(detected)));
    expect(config.fix).toEqual(seededFix);
  });

  it('seeds the same fix block when only lint:fix is path-taking', () => {
    const ctx = makeCtx({
      packageManager: pnpm,
      rootPkg: {
        name: 'my-repo',
        scripts: { 'lint:fix': 'eslint --fix', format: 'prettier --write .' },
      },
    });
    const config = JSON.parse(renderHouseConfig(ctx, answers(detected)));
    expect(config.fix).toEqual(seededFix);
  });

  it('seeds the same fix block when the target has no fixCommands', () => {
    const ctx = makeCtx({ packageManager: pnpm });
    const config = JSON.parse(renderHouseConfig(ctx, answers()));
    expect(config.fix).toEqual(seededFix);
  });

  it('writes no passPaths key when lint-fix is not selected', () => {
    const ctx = makeCtx({
      packageManager: pnpm,
      rootPkg: {
        name: 'my-repo',
        scripts: { 'lint:fix': 'eslint --fix', format: 'prettier --write' },
      },
    });
    const config = JSON.parse(
      renderHouseConfig(ctx, makeAnswers({ moduleIds: ['core'] })),
    );
    expect('passPaths' in config.fix).toBe(false);
  });

  it('writes no passPaths key for an npm monorepo and seeds an empty filterFlag', () => {
    const pkgScripts = {
      'lint:fix': 'eslint --fix',
      format: 'prettier --write',
    };
    const ctx = makeCtx({
      isMonorepo: true,
      rootPkg: {
        name: 'my-repo',
        scripts: { 'lint:fix': 'eslint . --fix', format: 'prettier --write .' },
      },
      packages: [
        {
          name: 'a',
          dir: '/repo/packages/a',
          relDir: 'packages/a',
          pkg: { name: 'a', scripts: pkgScripts },
        },
        {
          name: 'b',
          dir: '/repo/packages/b',
          relDir: 'packages/b',
          pkg: { name: 'b', scripts: pkgScripts },
        },
      ],
    });
    const config = JSON.parse(
      renderHouseConfig(
        ctx,
        makeAnswers({
          moduleIds: ['core', 'lint-fix'],
          targets: [
            makeTarget({
              name: 'a',
              packageName: 'a',
              pathPrefix: 'packages/a/',
              fixCommands: ['lint:fix', 'format'],
            }),
            makeTarget({
              name: 'b',
              packageName: 'b',
              pathPrefix: 'packages/b/',
              fixCommands: ['lint:fix', 'format'],
            }),
          ],
        }),
      ),
    );
    expect(config.fix.filterFlag).toBe('');
    expect('passPaths' in config.fix).toBe(false);
  });
});

describe('passPaths default: the change', () => {
  const answers = (names: string[]) =>
    makeAnswers({
      moduleIds: ['core', 'lint-fix'],
      targets: names.map((n) =>
        makeTarget({
          name: n,
          packageName: n,
          pathPrefix: n === 'core' ? '' : `packages/${n}/`,
          fixCommands: ['lint:fix', 'format'],
        }),
      ),
    });

  it('seeds fix.passPaths true for path-taking scripts in a single-package repo', () => {
    const ctx = makeCtx({
      packageManager: { name: 'pnpm', source: 'lockfile' },
      rootPkg: {
        name: 'my-repo',
        scripts: { 'lint:fix': 'eslint --fix', format: 'prettier --write' },
      },
    });
    const config = JSON.parse(renderHouseConfig(ctx, answers(['core'])));
    expect(config.fix.passPaths).toBe(true);
  });

  it('seeds fix.passPaths true for a pnpm monorepo whose packages take paths, with filterFlag --filter', () => {
    const pkgScripts = {
      'lint:fix': 'eslint --fix',
      format: 'prettier --write',
    };
    const ctx = makeCtx({
      packageManager: { name: 'pnpm', source: 'lockfile' },
      isMonorepo: true,
      rootPkg: {
        name: 'my-repo',
        scripts: { 'lint:fix': 'eslint . --fix', format: 'prettier --write .' },
      },
      packages: ['a', 'b'].map((n) => ({
        name: n,
        dir: `/repo/packages/${n}`,
        relDir: `packages/${n}`,
        pkg: { name: n, scripts: pkgScripts },
      })),
    });
    const config = JSON.parse(renderHouseConfig(ctx, answers(['a', 'b'])));
    expect(config.fix.filterFlag).toBe('--filter');
    expect(config.fix.passPaths).toBe(true);
  });
});

describe('lintable extensions: today', () => {
  it('seeds each of the 11 extensions the default list carries', () => {
    const config = JSON.parse(
      renderHouseConfig(makeCtx(), makeAnswers({ targets: [makeTarget()] })),
    );
    expect(config.lintableExtensions).toEqual(
      expect.arrayContaining([
        'ts',
        'tsx',
        'js',
        'jsx',
        'mjs',
        'cjs',
        'svelte',
        'md',
        'json',
        'css',
        'html',
      ]),
    );
  });
});

describe('lintable extensions: the change', () => {
  it('seeds mts and cts after cjs', () => {
    const config = JSON.parse(
      renderHouseConfig(makeCtx(), makeAnswers({ targets: [makeTarget()] })),
    );
    expect(config.lintableExtensions).toEqual([
      'ts',
      'tsx',
      'js',
      'jsx',
      'mjs',
      'cjs',
      'mts',
      'cts',
      'svelte',
      'md',
      'json',
      'css',
      'html',
    ]);
  });
});
