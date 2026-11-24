import { describe, expect, it, onTestFinished } from 'vitest';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  editHouseConfig,
  manifestOf,
  readJson,
  sha256,
  writeManifest,
} from '#test/installed-tree';
import { useInstalledRepo } from '#test/repo';
import { runCli, runIn, type RunResult } from '#test/run';
import { splitFrontmatter } from '../../core/frontmatter.js';

const EDITED_SKILL = '.claude/skills/tidy/SKILL.md';
const UNEDITED_SKILL = '.claude/skills/ready/SKILL.md';
const RULE = '.claude/rules/code-cleanliness.md';
const RULE_ID = 'code-cleanliness';
const MANIFEST = '.claude/houserules.manifest.json';
const VERSION_CHECK_CACHE = '.claude/state/version-check.json';
const HOOK_RUNS_LOG = '.claude/state/hook-runs.jsonl';
const HOOK_RUNS_ROTATED = '.claude/state/hook-runs.1.jsonl';
const CONFIG = '.claude/houserules.config.json';
const GITIGNORE = '.claude/.gitignore';
const SETTINGS = '.claude/settings.json';
const GUARD_SCRIPT = '.claude/scripts/guard-bash.mjs';
const KEPT_PATHS = ['**/*.ts', '**/*.mts'];
const EDIT = '\nmy team edit\n';

interface MigrateConfig {
  modules?: string[];
  ejected?: string[];
  rules?: Record<string, { paths?: string[] }>;
}

function git(root: string, ...args: string[]): string {
  return runIn(root, 'git', args);
}

function read(root: string, dest: string): string {
  return readFileSync(join(root, dest), 'utf8');
}

function configOf(root: string): MigrateConfig {
  return readJson<MigrateConfig>(join(root, CONFIG));
}

function isTracked(root: string, dest: string): boolean {
  return git(root, 'ls-files', '--', dest).trim() === dest;
}

function trimRulePaths(root: string): string {
  const { frontmatter, body } = splitFrontmatter(read(root, RULE));
  const kept = new Set(KEPT_PATHS.map((glob) => `  - '${glob}'`));
  const trimmed = frontmatter
    .split('\n')
    .filter((line) => !line.startsWith('  - ') || kept.has(line))
    .join('\n');
  writeFileSync(join(root, RULE), trimmed + body);
  return trimmed;
}

function blockDests(root: string): string[] {
  return read(root, GITIGNORE)
    .split('\n')
    .filter((line) => line.startsWith('/'))
    .map((line) => `.claude${line}`);
}

function installedRepo(config: Record<string, unknown> = {}): string {
  const root = useInstalledRepo('npm-single', {
    modules: 'code-cleanliness,ready,orchestrate',
  });
  editHouseConfig(root, (current) => {
    delete current.modules;
    Object.assign(current, config);
  });
  return root;
}

function commitInstall(root: string): void {
  git(root, 'add', '-f', '.claude');
  git(root, 'commit', '-qm', 'committed install');
}

function editedCommittedInstall(config: Record<string, unknown> = {}): {
  root: string;
  editedSkill: string;
  trimmedFrontmatter: string;
  classified: string[];
} {
  const root = installedRepo(config);
  appendFileSync(join(root, EDITED_SKILL), EDIT);
  const editedSkill = read(root, EDITED_SKILL);
  const trimmedFrontmatter = trimRulePaths(root);
  const classified = blockDests(root).filter(
    (dest) =>
      dest !== MANIFEST &&
      dest !== EDITED_SKILL &&
      dest !== VERSION_CHECK_CACHE &&
      dest !== HOOK_RUNS_LOG &&
      dest !== HOOK_RUNS_ROTATED,
  );
  commitInstall(root);
  return { root, editedSkill, trimmedFrontmatter, classified };
}

function indexState(root: string): string {
  return git(root, 'ls-files', '--stage');
}

function stagedChanges(root: string): string {
  return git(root, 'diff', '--cached', '--name-status', '--relative');
}

function updateOk(root: string, ...args: string[]): RunResult {
  const result = runCli(['update', ...args, root]);
  expect(result.status, result.stderr + result.stdout).toBe(0);
  return result;
}

function unwrapped(text: string): string {
  return text.replace(/[\s│]+/g, ' ');
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function copyWithoutGit(from: string, to: string): void {
  cpSync(from, to, {
    recursive: true,
    filter: (src) => !src.startsWith(join(from, '.git')),
  });
}

function gitInit(root: string): void {
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'kit-test@example.com');
  git(root, 'config', 'user.name', 'houserules test');
}

describe('update on an install that committed its payload', () => {
  it('records the modules, ejects the edited skill, and moves the trimmed rule paths into the config', () => {
    const { root } = editedCommittedInstall();

    updateOk(root);

    const config = configOf(root);
    expect(config.modules).toEqual(
      expect.arrayContaining(['core', 'code-cleanliness', 'ready']),
    );
    expect(config.ejected).toEqual([EDITED_SKILL]);
    expect(config.rules?.[RULE_ID]?.paths).toEqual(KEPT_PATHS);
  });

  it('keeps the edited skill tracked with its edit', () => {
    const { root, editedSkill } = editedCommittedInstall();

    updateOk(root);

    expect(isTracked(root, EDITED_SKILL)).toBe(true);
    expect(read(root, EDITED_SKILL)).toBe(editedSkill);
  });

  it('removes every other classified file and the manifest from the index and keeps them on disk', () => {
    const { root, classified, trimmedFrontmatter } = editedCommittedInstall();
    expect(classified).toContain(RULE);
    expect(classified).toContain(UNEDITED_SKILL);

    updateOk(root);

    for (const dest of [...classified, MANIFEST]) {
      expect(isTracked(root, dest), `${dest} untracked`).toBe(false);
      expect(existsSync(join(root, dest)), `${dest} on disk`).toBe(true);
    }
    expect(splitFrontmatter(read(root, RULE)).frontmatter).toBe(
      trimmedFrontmatter,
    );
    const staged = stagedChanges(root).trim().split('\n');
    expect(staged).toContain(`D\t${MANIFEST}`);
    expect(staged).toContain(`D\t${UNEDITED_SKILL}`);
    expect(staged.every((line) => line.startsWith('D\t'))).toBe(true);
  });

  it('commits nothing', () => {
    const { root } = editedCommittedInstall();
    const head = git(root, 'rev-parse', 'HEAD');

    updateOk(root);

    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('names the ejected skill in its summary', () => {
    const { root } = editedCommittedInstall();

    const output = unwrapped(updateOk(root).stdout);

    expect(output).toContain(
      `ejected 1 edited file(s), which stay committed as yours: ${EDITED_SKILL}`,
    );
  });

  it('names the ignore block and the config in its one git add line', () => {
    const { root } = editedCommittedInstall();

    const output = unwrapped(updateOk(root).stdout);

    expect(output).toContain(
      `git add ${GITIGNORE} ${CONFIG} Commit them in the same commit as the staged removals.`,
    );
  });

  it('adds every other file it wrote that the ignore block does not list to the git add line', () => {
    const { root } = editedCommittedInstall();
    rmSync(join(root, SETTINGS));

    const output = unwrapped(updateOk(root).stdout);

    expect(output).toContain(
      `git add ${GITIGNORE} ${CONFIG} ${SETTINGS} Commit`,
    );
  });

  it('leaves HEAD, the staged removals, and the config as the first run left them on a second run', () => {
    const { root } = editedCommittedInstall();
    updateOk(root);
    const head = git(root, 'rev-parse', 'HEAD');
    const staged = stagedChanges(root);
    const config = read(root, CONFIG);

    updateOk(root);

    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(stagedChanges(root)).toBe(staged);
    expect(read(root, CONFIG)).toBe(config);
  });
});

describe('update --dry-run on an install that committed its payload', () => {
  it('leaves the index and the config unchanged and prints the summary', () => {
    const { root } = editedCommittedInstall();
    const index = indexState(root);
    const config = read(root, CONFIG);

    const output = unwrapped(updateOk(root, '--dry-run').stdout);

    expect(indexState(root)).toBe(index);
    expect(read(root, CONFIG)).toBe(config);
    expect(output).toContain('would untrack');
    expect(output).toContain(EDITED_SKILL);
    expect(output).toContain(`git add ${GITIGNORE} ${CONFIG}`);
  });
});

describe('update --sync on an install that committed its payload', () => {
  it('runs no migration and leaves the index unchanged', () => {
    const { root } = editedCommittedInstall();
    const index = indexState(root);

    expect(runCli(['update', '--sync', root]).status).toBe(0);

    expect(indexState(root)).toBe(index);
    expect(configOf(root).ejected).toBeUndefined();
  });
});

describe('update with payload.commit: true on an install that committed its payload', () => {
  function committedPayload(): string {
    const root = installedRepo({ payload: { commit: true } });
    appendFileSync(join(root, EDITED_SKILL), EDIT);
    trimRulePaths(root);
    rmSync(join(root, GITIGNORE));
    commitInstall(root);
    return root;
  }

  it('writes the modules into the config and nothing else of the migration', () => {
    const root = committedPayload();

    updateOk(root);

    const config = configOf(root);
    expect(config.modules).toEqual(expect.arrayContaining(['core', 'ready']));
    expect(config.ejected).toBeUndefined();
    expect(config.rules).toBeUndefined();
  });

  it('ignores only the script-written paths, so no committed payload file goes untracked', () => {
    const root = committedPayload();

    updateOk(root);

    const ignored = read(root, GITIGNORE)
      .split('\n')
      .filter((line) => line.startsWith('/'));
    expect(ignored).toEqual([
      '/state/hook-runs.1.jsonl',
      '/state/hook-runs.jsonl',
      VERSION_CHECK_CACHE.replace('.claude', ''),
    ]);
  });

  it('keeps the payload and the manifest tracked and still untracks the scripts', () => {
    const root = committedPayload();

    updateOk(root);

    for (const dest of [EDITED_SKILL, UNEDITED_SKILL, RULE, MANIFEST]) {
      expect(isTracked(root, dest), `${dest} tracked`).toBe(true);
    }
    expect(isTracked(root, GUARD_SCRIPT)).toBe(false);
  });
});

describe('update on a committed install with a retired payload file', () => {
  const RETIRED = '.claude/skills/retired-skill/SKILL.md';
  const RETIRED_TEXT = '# retired\n';

  function installWithRetiredFile(): string {
    const root = installedRepo();
    mkdirSync(join(root, dirname(RETIRED)), { recursive: true });
    writeFileSync(join(root, RETIRED), RETIRED_TEXT);
    const manifest = manifestOf(root);
    (manifest.files as Record<string, unknown>)[RETIRED] = sha256(RETIRED_TEXT);
    writeManifest(root, manifest);
    commitInstall(root);
    return root;
  }

  function stageCommand(output: string): string {
    const found = /(git add .+?) Commit them/.exec(unwrapped(output));
    expect(found, output).not.toBeNull();
    return found![1]!;
  }

  it('names the pruned file in the git add line of a dry run', () => {
    const root = installWithRetiredFile();

    expect(
      stageCommand(updateOk(root, '--dry-run').stdout).split(' '),
    ).toContain(RETIRED);
    expect(existsSync(join(root, RETIRED))).toBe(true);
  });

  it('names the pruned file, so the printed git add leaves nothing unstaged under .claude/', () => {
    const root = installWithRetiredFile();

    const command = stageCommand(updateOk(root).stdout);

    expect(existsSync(join(root, RETIRED))).toBe(false);
    expect(command.split(' ')).toContain(RETIRED);
    runIn(root, 'sh', ['-c', command]);
    const unstaged = git(root, 'status', '--short', '--', '.claude')
      .split('\n')
      .filter((line) => line.length > 1 && line[1] !== ' ');
    expect(unstaged).toEqual([]);
    expect(stagedChanges(root)).toContain(`D\t${RETIRED}`);
  });
});

describe('update on a fresh clone of an install that committed its payload', () => {
  it('raises no manifest finding for the ignored scripts and templates it never received', () => {
    const { root } = editedCommittedInstall();
    // A fresh clone carries only what git tracks, and these two dirs ignore everything but their own .gitignore.
    git(
      root,
      'rm',
      '-r',
      '-q',
      '--cached',
      '.claude/scripts',
      '.claude/templates',
    );
    git(
      root,
      'add',
      '-f',
      '.claude/scripts/.gitignore',
      '.claude/templates/.gitignore',
    );
    git(root, 'commit', '-qm', 'stop tracking the generated dirs');
    for (const dir of ['.claude/scripts', '.claude/templates']) {
      for (const name of git(
        root,
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--',
        dir,
      )
        .split('\n')
        .filter(Boolean))
        rmSync(join(root, name));
    }
    expect(
      git(
        root,
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--',
        '.claude/scripts',
      ),
    ).toBe('');

    const result = updateOk(root);

    expect(unwrapped(result.stdout + result.stderr)).not.toContain(
      'manifest disagrees',
    );
    expect(stagedChanges(root)).toContain(`D\t${UNEDITED_SKILL}`);
  });
});

describe('update on an install with no git work tree', () => {
  it('skips the migration and exits 0', () => {
    const source = installedRepo();
    const root = join(tempDir('kit-no-git-'), 'repo');
    copyWithoutGit(source, root);

    const result = updateOk(root);

    expect(unwrapped(result.stdout)).not.toContain('payload:');
  });
});

describe('update on a committed install one directory below the git root', () => {
  function nestedCommittedInstall(): string {
    const { root: source } = editedCommittedInstall();
    const outer = tempDir('kit-nested-');
    gitInit(outer);
    const root = join(outer, 'app');
    mkdirSync(root);
    copyWithoutGit(source, root);
    git(outer, 'add', '-A');
    git(outer, 'add', '-f', 'app/.claude');
    git(outer, 'commit', '-qm', 'committed install below the root');
    return root;
  }

  it('migrates the same set as an install at the root', () => {
    const { root: flat } = editedCommittedInstall();
    const nested = nestedCommittedInstall();

    updateOk(flat);
    updateOk(nested);

    expect(stagedChanges(nested)).toBe(stagedChanges(flat));
    expect(configOf(nested).ejected).toEqual([EDITED_SKILL]);
    expect(configOf(nested).rules?.[RULE_ID]?.paths).toEqual(KEPT_PATHS);
  });
});

describe('update with scripts.commit: true on an install that committed its payload', () => {
  it('keeps the scripts committed and migrates the rest', () => {
    const root = installedRepo({ scripts: { commit: true } });
    commitInstall(root);

    updateOk(root);

    expect(isTracked(root, GUARD_SCRIPT)).toBe(true);
    expect(isTracked(root, UNEDITED_SKILL)).toBe(false);
    expect(isTracked(root, MANIFEST)).toBe(false);
  });
});
