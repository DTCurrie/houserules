import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Action, HouseConfig, RegionAction } from '@houserules/api';
import { upsertRegion } from '@houserules/api/internal';
import { makeAnswers, makeCtx, makeRegistry } from '#test/ctx-builder';
import { buildPlan, MODULES } from '../../plan.js';
import {
  PAYLOAD_GITIGNORE_REGION,
  payloadGitignoreActions,
} from '../payload-gitignore.js';

function write(dest: string, content = 'x\n'): Action {
  return { kind: 'write', module: 'core', dest, content, reason: 'test' };
}

function copy(dest: string): Action {
  return {
    kind: 'copy',
    module: 'core',
    src: `/payload/${dest}`,
    dest,
    reason: 'test',
  };
}

function ctxWithConfig(config: Record<string, unknown>) {
  const ctx = makeCtx();
  ctx.claude.houseConfig = config as unknown as HouseConfig;
  return ctx;
}

function listedPaths(
  actions: Action[],
  ctx: ReturnType<typeof makeCtx> = makeCtx(),
): string[] {
  const [block, ...rest] = payloadGitignoreActions(ctx, actions);
  expect(rest).toEqual([]);
  return (block as RegionAction).body
    .split('\n')
    .filter((line) => !line.startsWith('#'));
}

describe('payloadGitignoreActions, the region it plans', () => {
  it('plans one core region at .claude/.gitignore under the gitignore markers', () => {
    const actions = payloadGitignoreActions(makeCtx(), []);

    expect(actions).toEqual([
      expect.objectContaining({
        kind: 'region',
        dest: '.claude/.gitignore',
        module: 'core',
        region: {
          id: 'gitignore',
          start: '# houserules:gitignore start',
          end: '# houserules:gitignore end',
          anchor: 'eof',
        },
      }),
    ]);
  });

  it('opens the body with one comment line', () => {
    const [block] = payloadGitignoreActions(makeCtx(), [
      copy('.claude/rules/a.md'),
    ]);

    const lines = (block as RegionAction).body.split('\n');
    expect(lines[0]).toMatch(/^# /);
    expect(lines.filter((line) => line.startsWith('#'))).toHaveLength(1);
  });

  it('plans nothing when payload.commit is true', () => {
    const ctx = ctxWithConfig({ payload: { commit: true } });

    expect(payloadGitignoreActions(ctx, [copy('.claude/rules/a.md')])).toEqual(
      [],
    );
  });

  it('still plans the block when payload.commit is false', () => {
    const ctx = ctxWithConfig({ payload: { commit: false } });

    expect(payloadGitignoreActions(ctx, [])).toHaveLength(1);
  });
});

describe('payloadGitignoreActions, the paths it lists', () => {
  it('lists the manifest even when no module writes under .claude/', () => {
    expect(listedPaths([])).toEqual(['/houserules.manifest.json']);
  });

  it('lists each copy, write and body dest relative to .claude/ with a leading slash, sorted and deduplicated', () => {
    const body: Action = {
      kind: 'body',
      module: 'core',
      src: '/payload/rules/b.md',
      dest: '.claude/rules/b.md',
      reason: 'test',
    };

    expect(
      listedPaths([
        write('.claude/skills/zeta/SKILL.md'),
        copy('.claude/agents/reviewer.md'),
        body,
        copy('.claude/agents/reviewer.md'),
      ]),
    ).toEqual([
      '/agents/reviewer.md',
      '/houserules.manifest.json',
      '/rules/b.md',
      '/skills/zeta/SKILL.md',
    ]);
  });

  it('leaves out seeds, regions and settings merges', () => {
    const actions: Action[] = [
      {
        kind: 'seed',
        module: 'core',
        dest: '.claude/houserules.config.json',
        content: '{}\n',
        reason: 'test',
      },
      {
        kind: 'region',
        module: 'core',
        dest: '.claude/notes.md',
        body: 'x',
        region: PAYLOAD_GITIGNORE_REGION,
        reason: 'test',
      },
      {
        kind: 'merge-settings',
        module: 'core',
        fragment: {},
        reason: 'test',
      } as unknown as Action,
    ];

    expect(listedPaths(actions)).toEqual(['/houserules.manifest.json']);
  });

  it('leaves out each ejected dest and still lists every other dest', () => {
    const ctx = ctxWithConfig({
      ejected: ['.claude/skills/tidy/SKILL.md', '.claude/rules/a.md'],
    });

    expect(
      listedPaths(
        [
          write('.claude/skills/tidy/SKILL.md'),
          write('.claude/skills/other/SKILL.md'),
          write('.claude/rules/a.md'),
          write('.claude/rules/b.md'),
        ],
        ctx,
      ),
    ).toEqual([
      '/houserules.manifest.json',
      '/rules/b.md',
      '/skills/other/SKILL.md',
    ]);
  });

  it('leaves out dests outside .claude/', () => {
    expect(
      listedPaths([write('docs/guide.md'), write('.github/x.yml')]),
    ).toEqual(['/houserules.manifest.json']);
  });

  it('leaves out every dest under a directory the plan self-ignores with a `*` line, including that .gitignore', () => {
    expect(
      listedPaths([
        write('.claude/plans/.gitignore', '# local\n*\n!.gitignore\n'),
        write('.claude/plans/README.md'),
        write('.claude/plansbook.md'),
      ]),
    ).toEqual(['/houserules.manifest.json', '/plansbook.md']);
  });

  it('keeps dests under a directory whose .gitignore has no `*` line', () => {
    expect(
      listedPaths([
        write('.claude/rules/.gitignore', '*.tmp\n'),
        write('.claude/rules/a.md'),
      ]),
    ).toEqual([
      '/houserules.manifest.json',
      '/rules/.gitignore',
      '/rules/a.md',
    ]);
  });

  it('lists .claude/scripts/ dests by default when the plan does not self-ignore that directory', () => {
    expect(listedPaths([write('.claude/scripts/guard.mjs')])).toContain(
      '/scripts/guard.mjs',
    );
  });

  it('leaves out every .claude/scripts/ dest when scripts.commit is true', () => {
    const ctx = ctxWithConfig({ scripts: { commit: true } });

    expect(
      listedPaths(
        [write('.claude/scripts/guard.mjs'), write('.claude/rules/a.md')],
        ctx,
      ),
    ).toEqual(['/houserules.manifest.json', '/rules/a.md']);
  });

  it('escapes glob characters so a line matches only the file it names', () => {
    expect(listedPaths([write('.claude/skills/[draft]/SKILL*.md')])).toContain(
      '/skills/\\[draft]/SKILL\\*.md',
    );
  });
});

describe('the .claude/.gitignore block under git', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function gitRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kit-payload-gitignore-'));
    dirs.push(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir });
    return dir;
  }

  function touch(root: string, path: string): void {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), 'x\n');
  }

  function ignoredAmong(root: string, paths: string[]): string[] {
    const result = spawnSync('git', ['check-ignore', '--', ...paths], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).not.toBe(128);
    return result.stdout.split('\n').filter(Boolean).sort();
  }

  it('ignores each kit dest and never a user-authored skill beside the kit skills', () => {
    const block = payloadGitignoreActions(
      makeCtx(),
      buildPlan(
        makeCtx(),
        makeAnswers({ moduleIds: MODULES.map((module) => module.id) }),
        makeRegistry(MODULES),
      ),
    )[0] as RegionAction;
    const kitDests = block.body
      .split('\n')
      .filter((line) => line.startsWith('/'))
      .map((line) => `.claude${line}`);
    const kitSkill = kitDests.find((dest) =>
      dest.startsWith('.claude/skills/'),
    );
    expect(kitSkill, 'the built-in modules list a skill').toMatch(
      /^\.claude\/skills\/.+\/SKILL\.md$/,
    );
    const userSkill = '.claude/skills/my-own/SKILL.md';
    const root = gitRepo();
    for (const dest of [...kitDests, userSkill]) touch(root, dest);
    writeFileSync(
      join(root, '.claude/.gitignore'),
      upsertRegion(null, block.body, block.region).content,
    );

    const ignored = ignoredAmong(root, [...kitDests, userSkill]);

    expect(ignored).toEqual([...kitDests].sort());
    expect(ignored).not.toContain(userSkill);
  });
});
