import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';

interface RootCase {
  cwd: string;
  env?: Record<string, string>;
  root: string | null;
}

const scratchDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function scratch(prefix = 'kit-root-'): string {
  const directory = mkdtempSync(`${realpathSync(tmpdir())}/${prefix}`);
  scratchDirectories.push(directory);
  return directory;
}

function runGit(...args: string[]): void {
  execFileSync('git', args, { stdio: 'ignore' });
}

function initRepository(directory: string, ...flags: string[]): string {
  runGit('init', '-q', ...flags, directory);
  return directory;
}

function commitEmpty(repository: string): void {
  runGit(
    '-C',
    repository,
    '-c',
    'user.name=kit',
    '-c',
    'user.email=kit@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--no-verify',
    '--allow-empty',
    '-m',
    'init',
  );
}

function makeDirectory(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

function withoutGitOnPath(): void {
  vi.stubEnv('PATH', scratch('kit-empty-path-'));
}

function stubEnvironment(env: Record<string, string> | undefined): void {
  for (const [name, value] of Object.entries(env ?? {})) {
    vi.stubEnv(name, value);
  }
}

function subdirectoryOfRepository(): RootCase {
  const base = scratch();
  initRepository(`${base}/r`);
  return { cwd: makeDirectory(`${base}/r/sub/deep`), root: `${base}/r` };
}

function linkedWorktreeRoot(): RootCase {
  const base = scratch();
  initRepository(`${base}/r`);
  commitEmpty(`${base}/r`);
  runGit('-C', `${base}/r`, 'worktree', 'add', '-q', `${base}/wt`);
  return { cwd: `${base}/wt`, root: `${base}/wt` };
}

function nestedRepository(): RootCase {
  const base = scratch();
  initRepository(`${base}/r`);
  initRepository(`${base}/r/inner`);
  return { cwd: makeDirectory(`${base}/r/inner/x`), root: `${base}/r/inner` };
}

function gitDirSet(): RootCase {
  const base = scratch();
  initRepository(`${base}/r`);
  return {
    cwd: makeDirectory(`${base}/r/sub`),
    env: { GIT_DIR: `${base}/r/.git` },
    root: `${base}/r/sub`,
  };
}

function gitWorkTreeSet(): RootCase {
  const base = scratch();
  initRepository(`${base}/r`);
  return {
    cwd: makeDirectory(`${base}/r/sub`),
    env: { GIT_WORK_TREE: `${base}/r/sub` },
    root: `${base}/r/sub`,
  };
}

function ceilingAtRoot(): RootCase {
  const base = scratch();
  initRepository(`${base}/r`);
  return {
    cwd: makeDirectory(`${base}/r/sub`),
    env: { GIT_CEILING_DIRECTORIES: `${base}/r` },
    root: null,
  };
}

function discoveryAcrossFilesystemSet(): RootCase {
  const base = scratch();
  initRepository(`${base}/r`);
  return {
    cwd: makeDirectory(`${base}/r/sub`),
    env: { GIT_DISCOVERY_ACROSS_FILESYSTEM: '1' },
    root: `${base}/r`,
  };
}

function insideDotGit(): RootCase {
  const base = scratch();
  initRepository(`${base}/r`);
  return { cwd: `${base}/r/.git/refs`, root: null };
}

function strayDotGitDirectoryWithoutHead(): RootCase {
  const base = scratch();
  initRepository(`${base}/r`);
  makeDirectory(`${base}/r/s/.git`);
  return { cwd: `${base}/r/s`, root: `${base}/r` };
}

function strayDotGitFileWithoutGitdir(): RootCase {
  const base = scratch();
  initRepository(`${base}/r`);
  makeDirectory(`${base}/r/s`);
  writeFileSync(`${base}/r/s/.git`, 'garbage\n');
  return { cwd: `${base}/r/s`, root: null };
}

function dotGitFileNamingMissingDirectory(): RootCase {
  const base = scratch();
  initRepository(`${base}/r`);
  makeDirectory(`${base}/r/s`);
  writeFileSync(`${base}/r/s/.git`, 'gitdir: ./missing\n');
  return { cwd: `${base}/r/s`, root: null };
}

function coreWorktreeSet(): RootCase {
  const base = scratch();
  initRepository(`${base}/r`);
  makeDirectory(`${base}/r/sub`);
  runGit('-C', `${base}/r`, 'config', 'core.worktree', `${base}/r/sub`);
  return { cwd: makeDirectory(`${base}/r/x`), root: `${base}/r/sub` };
}

function coreWorktreeInConfigWorktree(): RootCase {
  const base = scratch();
  initRepository(`${base}/r`);
  makeDirectory(`${base}/r/sub`);
  runGit('-C', `${base}/r`, 'config', 'extensions.worktreeConfig', 'true');
  runGit(
    '-C',
    `${base}/r`,
    'config',
    '--worktree',
    'core.worktree',
    `${base}/r/sub`,
  );
  return { cwd: makeDirectory(`${base}/r/x`), root: `${base}/r/sub` };
}

function includeSectionInConfig(): RootCase {
  const base = scratch();
  initRepository(`${base}/r`);
  makeDirectory(`${base}/r/sub`);
  writeFileSync(
    `${base}/r/.git/extra.inc`,
    `[core]\n\tworktree = ${base}/r/sub\n`,
  );
  runGit('-C', `${base}/r`, 'config', 'include.path', 'extra.inc');
  return { cwd: makeDirectory(`${base}/r/x`), root: `${base}/r` };
}

function gitCommonDirSet(): RootCase {
  const base = scratch();
  initRepository(`${base}/r`);
  return {
    cwd: makeDirectory(`${base}/r/sub`),
    env: { GIT_COMMON_DIR: `${base}/r/.git` },
    root: `${base}/r`,
  };
}

function coreBareSet(): RootCase {
  const base = scratch();
  initRepository(`${base}/r`);
  runGit('-C', `${base}/r`, 'config', 'core.bare', 'true');
  return { cwd: makeDirectory(`${base}/r/x`), root: null };
}

function bareRepositoryInsideWorkTree(): RootCase {
  const base = scratch();
  initRepository(`${base}/r`);
  initRepository(`${base}/r/b.git`, '--bare');
  return { cwd: `${base}/r/b.git`, root: null };
}

function outsideEveryWorkTree(): RootCase {
  return { cwd: scratch('kit-no-git-'), root: null };
}

async function freshRepoRoot(): Promise<() => string> {
  vi.resetModules();
  const proc = await import('../proc.mjs');
  return proc.repoRoot;
}

function inDirectory<TResult>(directory: string, run: () => TResult): TResult {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    return run();
  } finally {
    process.chdir(previous);
  }
}

async function resolveIn({ cwd, env }: RootCase): Promise<string> {
  const repoRoot = await freshRepoRoot();
  stubEnvironment(env);
  return inDirectory(cwd, () => repoRoot());
}

const ANSWERED_BY_GIT = [
  ['a subdirectory cwd', subdirectoryOfRepository],
  ['the root of a linked worktree', linkedWorktreeRoot],
  ['a cwd inside a nested repository', nestedRepository],
  ['GIT_DIR set', gitDirSet],
  ['GIT_WORK_TREE set', gitWorkTreeSet],
  ['GIT_DISCOVERY_ACROSS_FILESYSTEM set', discoveryAcrossFilesystemSet],
  ['a stray .git directory missing HEAD', strayDotGitDirectoryWithoutHead],
  ['core.worktree set', coreWorktreeSet],
  ['core.worktree set in config.worktree', coreWorktreeInConfigWorktree],
  ['an [include] section in the repository config', includeSectionInConfig],
  ['GIT_COMMON_DIR set', gitCommonDirSet],
] as const;

const REFUSED_BY_GIT = [
  ['GIT_CEILING_DIRECTORIES naming the root', ceilingAtRoot],
  ['a cwd inside .git', insideDotGit],
  ['a stray .git file with no gitdir line', strayDotGitFileWithoutGitdir],
  ['a .git file naming a missing directory', dotGitFileNamingMissingDirectory],
  ['core.bare set', coreBareSet],
  ['a bare repository inside a work tree', bareRepositoryInsideWorkTree],
  ['a cwd outside any work tree', outsideEveryWorkTree],
] as const;

const DEFERRED_TO_GIT = [
  ['GIT_DIR set', gitDirSet],
  ['GIT_WORK_TREE set', gitWorkTreeSet],
  ['GIT_CEILING_DIRECTORIES set', ceilingAtRoot],
  ['GIT_DISCOVERY_ACROSS_FILESYSTEM set', discoveryAcrossFilesystemSet],
  ['a cwd inside .git', insideDotGit],
  ['a stray .git directory missing HEAD', strayDotGitDirectoryWithoutHead],
  ['a stray .git file with no gitdir line', strayDotGitFileWithoutGitdir],
  ['a .git file naming a missing directory', dotGitFileNamingMissingDirectory],
  ['core.worktree set', coreWorktreeSet],
  ['core.worktree set in config.worktree', coreWorktreeInConfigWorktree],
  ['an [include] section in the repository config', includeSectionInConfig],
  ['GIT_COMMON_DIR set', gitCommonDirSet],
  ['core.bare set', coreBareSet],
  ['a bare repository inside a work tree', bareRepositoryInsideWorkTree],
  ['no .git entry up to the filesystem root', outsideEveryWorkTree],
] as const;

describe('repoRoot', () => {
  it.each(ANSWERED_BY_GIT)(
    'answers what git answers for %s',
    async (_, build) => {
      const rootCase = build();

      expect(await resolveIn(rootCase)).toBe(rootCase.root);
    },
  );

  it.each(REFUSED_BY_GIT)(
    'returns the cwd where git refuses: %s',
    async (_, build) => {
      const rootCase = build();

      expect(await resolveIn(rootCase)).toBe(rootCase.cwd);
    },
  );

  it.each(DEFERRED_TO_GIT)(
    'returns the cwd without git on PATH for %s',
    async (_, build) => {
      const rootCase = build();
      withoutGitOnPath();

      expect(await resolveIn(rootCase)).toBe(rootCase.cwd);
    },
  );

  it('returns the cwd without git on PATH when .git looks owned by another user', async () => {
    const rootCase = subdirectoryOfRepository();
    withoutGitOnPath();
    vi.spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1);

    expect(await resolveIn(rootCase)).toBe(rootCase.cwd);
  });

  it('resolves a repository to its root without git on PATH', async () => {
    const rootCase = subdirectoryOfRepository();
    withoutGitOnPath();

    expect(await resolveIn(rootCase)).toBe(rootCase.root);
  });

  it('answers each repository with its own root across two calls in one process', async () => {
    const first = subdirectoryOfRepository();
    const second = subdirectoryOfRepository();
    const repoRoot = await freshRepoRoot();
    inDirectory(first.cwd, () => repoRoot());

    expect(inDirectory(second.cwd, () => repoRoot())).toBe(second.root);
  });

  it('keeps the first answer for a cwd after GIT_DIR changes between two calls', async () => {
    const rootCase = subdirectoryOfRepository();
    const other = initRepository(`${scratch()}/other`);
    const repoRoot = await freshRepoRoot();
    inDirectory(rootCase.cwd, () => repoRoot());
    vi.stubEnv('GIT_DIR', `${other}/.git`);

    expect(inDirectory(rootCase.cwd, () => repoRoot())).toBe(rootCase.root);
  });
});
