import {
  beforeAll,
  afterAll,
  describe,
  expect,
  it,
  onTestFinished,
} from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type ThrowawayContext, guardRefusalFor } from '../guard-bash.mjs';

const TEMP_ROOTS = [tmpdir(), '/tmp'];
const HOP_LIMIT = 4;
const PROJECT_REMOTE = 'git@github.com:acme/widget.git';
const IDENT = [
  '-c',
  'user.name=fixture',
  '-c',
  'user.email=fixture@example.invalid',
  '-c',
  'commit.gpgsign=false',
];

interface Case {
  cmd: string;
  context: ThrowawayContext;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return env;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...IDENT, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: gitEnv(),
  });
}

function useBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'guard-throwaway-'));
  onTestFinished(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  return dir;
}

function initCommitted(dir: string): string {
  initRepo(dir);
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'fixture');
  return dir;
}

function makeProject(base: string): string {
  const project = initCommitted(join(base, 'project'));
  git(project, 'remote', 'add', 'origin', PROJECT_REMOTE);
  return project;
}

function withRemote(dir: string, url: string, name = 'origin'): string {
  git(dir, 'remote', 'add', name, url);
  return dir;
}

function localChain(base: string, hops: number): string {
  const repos = Array.from({ length: hops + 1 }, (_, i) =>
    initRepo(join(base, `hop-${i}`)),
  );
  for (let i = 0; i < hops; i++) withRemote(repos[i]!, repos[i + 1]!);
  return repos[0]!;
}

const throwaway = (projectDir: string | undefined): ThrowawayContext => ({
  projectDir,
  tempRoots: TEMP_ROOTS,
});

const commitByC = (dir: string): string =>
  `git -C ${dir} -c user.name= -c user.email= commit -m x`;
const commitByCd = (dir: string): string =>
  `cd ${dir} && git -c user.name= -c user.email= commit -m x`;
const checkoutByC = (dir: string): string => `git -C ${dir} checkout -- a.txt`;
const checkoutByCd = (dir: string): string =>
  `cd ${dir} && git checkout -- a.txt`;

const FIXTURE_COMMANDS: [string, (dir: string) => string][] = [
  ['a commit by -C', commitByC],
  ['a commit by a leading cd', commitByCd],
  ['a checkout -- <path> by -C', checkoutByC],
  ['a checkout -- <path> by a leading cd', checkoutByCd],
];

function expectRefused(scenario: Case): void {
  expect(guardRefusalFor(scenario.cmd, scenario.context)).toMatch(
    /Blocked by houserules guard/,
  );
}

describe('guardRefusalFor with a throwaway context', () => {
  let sharedBase: string;
  let sharedProject: string;

  beforeAll(() => {
    sharedBase = mkdtempSync(join(tmpdir(), 'guard-throwaway-shared-'));
    sharedProject = makeProject(sharedBase);
  });

  afterAll(() => {
    rmSync(sharedBase, { recursive: true, force: true });
  });

  it.each(FIXTURE_COMMANDS)(
    'allows %s in a fresh repo with no remote under a temp root',
    (_, command) => {
      const base = useBase();
      const project = sharedProject;
      const fixture = initRepo(join(base, 'fixture'));
      expect(guardRefusalFor(command(fixture), throwaway(project))).toBeNull();
    },
  );

  it('allows an add and a commit chained on the same -C target', () => {
    const base = useBase();
    const project = sharedProject;
    const fixture = initRepo(join(base, 'fixture'));
    expect(
      guardRefusalFor(
        `git -C ${fixture} add -A && git -C ${fixture} -c user.name= -c user.email= commit -m x`,
        throwaway(project),
      ),
    ).toBeNull();
  });

  it('allows a chain of local clones exactly at the hop limit', () => {
    const base = useBase();
    const project = sharedProject;
    const fixture = localChain(base, HOP_LIMIT);
    expect(guardRefusalFor(commitByC(fixture), throwaway(project))).toBeNull();
  });

  it('refuses the same commit with throwaway omitted', () => {
    const base = useBase();
    const fixture = initRepo(join(base, 'fixture'));
    expect(guardRefusalFor(commitByC(fixture))).toMatch(
      /Blocked by houserules guard/,
    );
  });

  it.each(FIXTURE_COMMANDS)(
    'refuses %s when there is no project dir',
    (_, command) => {
      const base = useBase();
      const fixture = initRepo(join(base, 'fixture'));
      expectRefused({ cmd: command(fixture), context: throwaway(undefined) });
      expectRefused({ cmd: command(fixture), context: throwaway('') });
    },
  );

  it.each<[string, (base: string) => Case]>([
    [
      'a commit in the project repo by -C',
      () => {
        const project = sharedProject;
        return { cmd: commitByC(project), context: throwaway(project) };
      },
    ],
    [
      'a commit in the project repo by a leading cd',
      () => {
        const project = sharedProject;
        return { cmd: commitByCd(project), context: throwaway(project) };
      },
    ],
    [
      'a discard in the project repo by -C',
      () => {
        const project = sharedProject;
        return { cmd: checkoutByC(project), context: throwaway(project) };
      },
    ],
    [
      'a clone whose remote is the project by plain path',
      (base) => {
        const project = sharedProject;
        const clone = withRemote(initRepo(join(base, 'clone')), project);
        return { cmd: commitByC(clone), context: throwaway(project) };
      },
    ],
    [
      'a clone made by git clone of the project',
      (base) => {
        const project = sharedProject;
        git(base, 'clone', '-q', project, join(base, 'clone'));
        return {
          cmd: commitByC(join(base, 'clone')),
          context: throwaway(project),
        };
      },
    ],
    [
      'a clone whose remote is the project by a path relative to the clone',
      (base) => {
        const project = makeProject(base);
        const clone = withRemote(
          initRepo(join(base, 'deep', 'clone')),
          '../../project',
        );
        return { cmd: commitByC(clone), context: throwaway(project) };
      },
    ],
    [
      'a clone whose remote is the project by file:// URL',
      (base) => {
        const project = sharedProject;
        const clone = withRemote(
          initRepo(join(base, 'clone')),
          `file://${project}`,
        );
        return { cmd: commitByC(clone), context: throwaway(project) };
      },
    ],
    [
      'a clone whose remote is the project by a symlinked path',
      (base) => {
        const project = makeProject(base);
        symlinkSync(project, join(base, 'link'));
        const clone = withRemote(
          initRepo(join(base, 'clone')),
          join(base, 'link'),
        );
        return { cmd: commitByC(clone), context: throwaway(project) };
      },
    ],
    [
      "a clone whose remote is the project's .git dir",
      (base) => {
        const project = sharedProject;
        const clone = withRemote(
          initRepo(join(base, 'clone')),
          join(project, '.git'),
        );
        return { cmd: commitByC(clone), context: throwaway(project) };
      },
    ],
    [
      'a clone of a clone of the project',
      (base) => {
        const project = sharedProject;
        const first = withRemote(initRepo(join(base, 'first')), project);
        const second = withRemote(initRepo(join(base, 'second')), first);
        return { cmd: commitByC(second), context: throwaway(project) };
      },
    ],
    [
      'a chain of local clones one hop longer than the hop limit',
      (base) => {
        const project = sharedProject;
        return {
          cmd: commitByC(localChain(base, HOP_LIMIT + 1)),
          context: throwaway(project),
        };
      },
    ],
    [
      'a temp repo whose core.worktree names the project dir',
      (base) => {
        const project = sharedProject;
        const fixture = initRepo(join(base, 'fixture'));
        git(fixture, 'config', 'core.worktree', project);
        return { cmd: commitByC(fixture), context: throwaway(project) };
      },
    ],
    [
      'a worktree of the project',
      (base) => {
        const project = makeProject(base);
        git(project, 'worktree', 'add', '-q', join(base, 'wt'));
        return {
          cmd: commitByC(join(base, 'wt')),
          context: throwaway(project),
        };
      },
    ],
    [
      'the main checkout of a project that is itself a worktree',
      (base) => {
        const main = initCommitted(join(base, 'main'));
        git(main, 'worktree', 'add', '-q', join(base, 'wt'));
        return { cmd: commitByC(main), context: throwaway(join(base, 'wt')) };
      },
    ],
    [
      'a repo nested inside the project dir',
      (base) => {
        const project = makeProject(base);
        const nested = initRepo(join(project, 'nested'));
        return { cmd: commitByC(nested), context: throwaway(project) };
      },
    ],
    [
      'a symlink inside a temp root that points into the project dir',
      (base) => {
        const project = makeProject(base);
        mkdirSync(join(project, 'src'));
        symlinkSync(join(project, 'src'), join(base, 'link'));
        return {
          cmd: commitByC(join(base, 'link')),
          context: throwaway(project),
        };
      },
    ],
    [
      'a repo outside the temp roots',
      (base) => {
        const project = sharedProject;
        const fixture = initRepo(join(base, 'fixture'));
        const otherRoot = useBase();
        return {
          cmd: commitByC(fixture),
          context: { projectDir: project, tempRoots: [otherRoot] },
        };
      },
    ],
    [
      'a git push in an exempt fixture',
      (base) => {
        const project = sharedProject;
        const fixture = initRepo(join(base, 'fixture'));
        return {
          cmd: `git -C ${fixture} push`,
          context: throwaway(project),
        };
      },
    ],
    [
      'a git stash in an exempt fixture',
      (base) => {
        const project = sharedProject;
        const fixture = initRepo(join(base, 'fixture'));
        return {
          cmd: `git -C ${fixture} stash`,
          context: throwaway(project),
        };
      },
    ],
    [
      'a command that commits in a fixture by -C and then in the project',
      (base) => {
        const project = sharedProject;
        const fixture = initRepo(join(base, 'fixture'));
        return {
          cmd: `${commitByC(fixture)} && ${commitByC(project)}`,
          context: throwaway(project),
        };
      },
    ],
    [
      'a command that commits in a fixture by cd and then in the project',
      (base) => {
        const project = sharedProject;
        const fixture = initRepo(join(base, 'fixture'));
        return {
          cmd: `${commitByCd(fixture)} && ${commitByC(project)}`,
          context: throwaway(project),
        };
      },
    ],
    [
      'a bare commit that names no target',
      () => {
        const project = sharedProject;
        return { cmd: 'git commit -m x', context: throwaway(project) };
      },
    ],
  ])('refuses %s', (_, build) => {
    expectRefused(build(useBase()));
  });

  it.each([
    'https://github.com/acme/widget',
    'https://github.com/acme/widget.git',
    'ssh://git@github.com/acme/widget',
    'ssh://git@github.com/acme/widget.git',
    'git@github.com:acme/widget',
    'git@github.com:acme/widget.git',
    'https://GitHub.com/Acme/Widget',
    'https://github.com/acme/widget/',
    'https://github.com/acme/widget.git/',
  ])("refuses a repo whose remote is the project's own remote as %s", (url) => {
    const base = useBase();
    const project = sharedProject;
    const onOrigin = withRemote(initRepo(join(base, 'origin-form')), url);
    const onSecond = withRemote(
      withRemote(
        initRepo(join(base, 'second-form')),
        'https://github.com/other/thing.git',
      ),
      url,
      'upstream',
    );
    expectRefused({ cmd: commitByC(onOrigin), context: throwaway(project) });
    expectRefused({ cmd: commitByC(onSecond), context: throwaway(project) });
  });

  it("refuses a repo whose push URL alone is the project's remote", () => {
    const base = useBase();
    const project = sharedProject;
    const fixture = withRemote(
      initRepo(join(base, 'fixture')),
      'https://github.com/other/thing.git',
    );
    git(
      fixture,
      'remote',
      'set-url',
      '--push',
      'origin',
      'https://github.com/acme/widget',
    );
    expectRefused({ cmd: commitByC(fixture), context: throwaway(project) });
  });

  it.each<[string, (fixture: string, project: string) => string]>([
    [
      'a relative -C path',
      () => 'git -C fixture -c user.name= -c user.email= commit -m x',
    ],
    ['a relative cd path', () => 'cd fixture && git commit -m x'],
    ['a variable -C path', () => 'git -C $FIXTURE commit -m x'],
    ['a variable cd path', () => 'cd $FIXTURE && git commit -m x'],
    ['a home-relative -C path', () => 'git -C ~/fixture commit -m x'],
    ['cd <dir>; git commit', (f) => `cd ${f}; git commit -m x`],
    ['a second cd', (f, p) => `cd ${f} && cd ${p} && git commit -m x`],
    ['a cd in a subshell', (f, p) => `cd ${f} && (cd ${p} && git commit -m x)`],
    ['a cd after a -C commit', (f, p) => `${commitByC(f)}; cd ${p}`],
    ['$(...) in the path', (f) => `cd $(echo ${f}) && git commit -m x`],
    ['$(...) in an argument', (f) => `git -C ${f} commit -m "$(date)"`],
    ['a backtick', (f) => `cd \`echo ${f}\` && git commit -m x`],
    ['a quoted -C path', (f) => `git -C "${f}" commit -m x`],
    [
      'a GIT_ variable',
      (f, p) => `export GIT_DIR=${p}/.git; git -C ${f} commit -m x`,
    ],
    ['--git-dir', (f, p) => `git -C ${f} --git-dir=${p}/.git commit -m x`],
    ['--work-tree', (f, p) => `git -C ${f} --work-tree=${p} checkout -- a.txt`],
    [
      'a -c key outside the allowlist',
      (f, p) => `git -C ${f} -c core.worktree=${p} commit -m x`,
    ],
    ['two -C paths', (f, p) => `git -C ${f} -C ${p} commit -m x`],
    [
      'a quoted -c value beside a -C into the project',
      (f, p) => `cd ${f} && git -c user.name='a' -C ${p} commit -m x`,
    ],
    [
      'a git call without -C beside a -C commit',
      (f) => `git -C ${f} add -A && git commit -m x`,
    ],
    [
      'a nested shell commit beside a -C commit',
      (f) => `${commitByC(f)}; bash -c 'git commit -m x'`,
    ],
  ])('refuses the unrecognized form %s', (_, build) => {
    const base = useBase();
    const project = sharedProject;
    const fixture = initRepo(join(base, 'fixture'));
    expectRefused({
      cmd: build(fixture, project),
      context: throwaway(project),
    });
  });
});
