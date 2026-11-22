import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';

import { useInstalledRepo } from '#test/repo';
import { runCli, runIn } from '#test/run';
import { editHouseConfig } from '#test/installed-tree';
import { driftFor, runDoctorJson } from '#test/doctor-report';
import { splitFrontmatter } from '../../core/frontmatter.js';

import * as ui from '../../ui.js';
import { eject as ejectCommand } from '../eject.js';

const SKILL = '.claude/skills/blast-radius/SKILL.md';
const RULE = '.claude/rules/code-cleanliness.md';
const CONFIG = '.claude/houserules.config.json';
const GITIGNORE = '.claude/.gitignore';
const START = '# houserules:gitignore start';
const END = '# houserules:gitignore end';
const ABOVE = '# my own lines above\n/user-above.txt\n';
const BELOW = '\n# my own lines below\n/user-below.txt\n';

function install(): string {
  const root = useInstalledRepo('pnpm-monorepo', {
    modules: 'code-cleanliness,orchestrate',
  });
  const path = join(root, GITIGNORE);
  const text = readFileSync(path, 'utf8');
  const end = text.indexOf(END) + END.length;
  writeFileSync(path, ABOVE + text.slice(0, end) + BELOW + text.slice(end));
  return root;
}

function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

/** The managed block, markers included, and everything around it. */
function splitBlock(text: string): { block: string; outside: string } {
  const start = text.indexOf(START);
  const end = text.indexOf(END) + END.length;
  return {
    block: text.slice(start, end),
    outside: text.slice(0, start) + text.slice(end),
  };
}

function blockLines(root: string): string[] {
  return splitBlock(read(root, GITIGNORE)).block.split('\n');
}

function eject(root: string, ...args: string[]) {
  return runCli(['--cwd', root, 'eject', ...args]);
}

function ignored(root: string, dest: string): boolean {
  return (
    spawnSync('git', ['check-ignore', '-q', dest], { cwd: root }).status === 0
  );
}

function indexFiles(root: string): string {
  return runIn(root, 'git', ['ls-files']);
}

function stagedChanges(root: string): string {
  return runIn(root, 'git', ['diff', '--cached', '--name-status']);
}

/** The config text `eject` writes, built from the bytes before it ran. */
function configWith(before: string, ejected: string[] | null): string {
  const config = JSON.parse(before) as Record<string, unknown>;
  if (ejected) config.ejected = ejected;
  else delete config.ejected;
  return `${JSON.stringify(config, null, 2)}\n`;
}

describe('eject of an owned file', () => {
  it.each([
    { kind: 'skill file', dest: SKILL, other: RULE },
    { kind: 'rule file', dest: RULE, other: SKILL },
  ])('takes ownership of a $kind', ({ dest, other }) => {
    const root = install();
    const configBefore = read(root, CONFIG);
    const gitignoreBefore = read(root, GITIGNORE);
    expect(ignored(root, dest)).toBe(true);

    const result = eject(root, dest);

    expect(result.status, result.stderr).toBe(0);
    expect(read(root, CONFIG)).toBe(configWith(configBefore, [dest]));
    const lines = blockLines(root);
    expect(lines).not.toContain(`/${dest.slice('.claude/'.length)}`);
    expect(lines).toContain(`/${other.slice('.claude/'.length)}`);
    expect(lines).toContain('/houserules.manifest.json');
    expect(splitBlock(read(root, GITIGNORE)).outside).toBe(
      splitBlock(gitignoreBefore).outside,
    );
    expect(result.stdout).toContain(`git add ${dest} ${CONFIG} ${GITIGNORE}`);
    expect(ignored(root, dest)).toBe(false);
    expect(indexFiles(root)).not.toContain(dest);
    expect(stagedChanges(root)).toBe('');
  });

  it('reads a leading ./ and an absolute path as the same dest', () => {
    const relative = install();
    const absolute = install();
    expect(eject(relative, `./${SKILL}`).status).toBe(0);
    expect(eject(absolute, join(absolute, SKILL)).status).toBe(0);
    for (const root of [relative, absolute]) {
      expect(JSON.parse(read(root, CONFIG)).ejected).toEqual([SKILL]);
      expect(blockLines(root)).not.toContain('/skills/blast-radius/SKILL.md');
    }
  });

  it('ejects several files in one run', () => {
    const root = install();
    const result = eject(root, SKILL, RULE);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(read(root, CONFIG)).ejected).toEqual([SKILL, RULE]);
    expect(result.stdout).toContain(
      `git add ${SKILL} ${RULE} ${CONFIG} ${GITIGNORE}`,
    );
  });

  it("leaves the manifest's install record alone, so a stale install still syncs", () => {
    const root = install();
    const path = join(root, '.claude/houserules.manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.kitVersion = '0.0.1';
    writeFileSync(path, JSON.stringify(manifest, null, 2));

    const result = eject(root, SKILL);

    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(result.status, result.stderr).toBe(0);
    expect(after.kitVersion).toBe('0.0.1');
    expect(after.modules).toEqual(manifest.modules);
    expect(after.plugins).toEqual(manifest.plugins);
  });

  it('changes nothing on a repeat eject', () => {
    const root = install();
    expect(eject(root, SKILL).status).toBe(0);
    const config = read(root, CONFIG);
    const gitignore = read(root, GITIGNORE);

    const result = eject(root, SKILL);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Already ejected');
    expect(result.stdout).not.toContain('git add');
    expect(read(root, CONFIG)).toBe(config);
    expect(read(root, GITIGNORE)).toBe(gitignore);
  });
});

describe('eject refusals', () => {
  function expectRefused(root: string, args: string[], reason: RegExp): void {
    const config = read(root, CONFIG);
    const gitignore = read(root, GITIGNORE);
    const files = indexFiles(root);

    const result = eject(root, ...args);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(reason);
    expect(read(root, CONFIG)).toBe(config);
    expect(read(root, GITIGNORE)).toBe(gitignore);
    expect(indexFiles(root)).toBe(files);
  }

  it('refuses a path houserules does not own', () => {
    expectRefused(install(), ['package.json'], /does not own/);
  });

  it('refuses a path outside the repo', () => {
    expectRefused(install(), ['../elsewhere.md'], /does not own/);
  });

  it('refuses a script, which every sync rewrites', () => {
    expectRefused(install(), ['.claude/scripts/guard-bash.mjs'], /every sync/);
  });

  it('refuses a template, which every sync rewrites', () => {
    const root = install();
    const template = runIn(root, 'git', [
      'ls-files',
      '--others',
      '.claude/templates',
    ])
      .split('\n')
      .find(Boolean);
    expect(template, 'an installed template').toBeDefined();
    expectRefused(root, [template!], /every sync/);
  });

  it('refuses the manifest', () => {
    expectRefused(install(), ['.claude/houserules.manifest.json'], /manifest/);
  });

  it('refuses settings.json, which git tracks', () => {
    expectRefused(install(), ['.claude/settings.json'], /git already tracks/);
  });

  it('refuses an owned file git already tracks', () => {
    const root = install();
    runIn(root, 'git', ['add', '-f', RULE]);
    expectRefused(root, [RULE], /git already tracks/);
  });

  it('refuses every file under payload.commit: true, where git tracks them all', () => {
    const root = install();
    editHouseConfig(root, (config) => {
      config.payload = { commit: true };
    });
    expectRefused(root, [RULE], /payload\.commit is true/);
  });

  it('refuses a directory and lists the owned files under it', () => {
    const root = install();
    const config = read(root, CONFIG);
    const result = eject(root, '.claude/skills/orchestrate');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/is a directory/);
    expect(result.stderr).toContain('.claude/skills/orchestrate/SKILL.md');
    expect(result.stderr).toContain(
      '.claude/skills/orchestrate/references/nested.md',
    );
    expect(result.stderr).not.toContain(SKILL);
    expect(read(root, CONFIG)).toBe(config);
  });

  it('writes nothing when one of several paths is refused', () => {
    expectRefused(install(), [SKILL, 'package.json'], /does not own/);
  });
});

describe('eject --undo', () => {
  /** Ejects `dest`, then edits it so a changed byte shows whether undo touched the file. */
  function ejectedAndEdited(dest: string): {
    root: string;
    configBefore: string;
    gitignoreBefore: string;
    edited: string;
  } {
    const root = install();
    const configBefore = read(root, CONFIG);
    const gitignoreBefore = read(root, GITIGNORE);
    expect(eject(root, dest).status).toBe(0);
    appendFileSync(join(root, dest), '\nmy team edit\n');
    return { root, configBefore, gitignoreBefore, edited: read(root, dest) };
  }

  it('returns an untracked file to the ignored set, bytes untouched', () => {
    const { root, configBefore, gitignoreBefore, edited } =
      ejectedAndEdited(SKILL);

    const result = eject(root, '--undo', SKILL);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`${SKILL} is ignored again.`);
    expect(result.stdout).not.toContain('Commit the staged removal');
    expect(read(root, CONFIG)).toBe(configWith(configBefore, null));
    expect(read(root, GITIGNORE)).toBe(gitignoreBefore);
    expect(read(root, SKILL)).toBe(edited);
    expect(ignored(root, SKILL)).toBe(true);
    expect(indexFiles(root)).not.toContain(SKILL);
  });

  it('keeps the other ejected files when one is returned', () => {
    const { root } = ejectedAndEdited(SKILL);
    expect(eject(root, RULE).status).toBe(0);
    expect(eject(root, '--undo', SKILL).status).toBe(0);
    expect(JSON.parse(read(root, CONFIG)).ejected).toEqual([RULE]);
  });

  it('unstages a file that was staged and never committed, with no commit to make', () => {
    const { root, configBefore, gitignoreBefore, edited } =
      ejectedAndEdited(RULE);
    runIn(root, 'git', ['add', '-f', RULE]);
    expect(indexFiles(root)).toContain(RULE);

    const result = eject(root, '--undo', RULE);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`${RULE} is ignored again.`);
    expect(result.stdout).not.toContain('Commit the staged removal');
    expect(indexFiles(root)).not.toContain(RULE);
    expect(stagedChanges(root)).toBe('');
    expect(read(root, CONFIG)).toBe(configWith(configBefore, null));
    expect(read(root, GITIGNORE)).toBe(gitignoreBefore);
    expect(read(root, RULE)).toBe(edited);
    expect(ignored(root, RULE)).toBe(true);
  });

  it('stages the removal of a committed file and says to commit it', () => {
    const { root, edited } = ejectedAndEdited(SKILL);
    runIn(root, 'git', ['add', '-f', SKILL]);
    runIn(root, 'git', ['commit', '-qm', 'share the skill']);

    const result = eject(root, '--undo', SKILL);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Commit the staged removal to finish.');
    expect(result.stdout).not.toContain(`${SKILL} is ignored again.`);
    expect(indexFiles(root)).not.toContain(SKILL);
    expect(stagedChanges(root)).toBe(`D\t${SKILL}\n`);
    expect(
      runIn(root, 'git', ['ls-tree', '-r', '--name-only', 'HEAD']),
    ).toContain(SKILL);
    expect(existsSync(join(root, SKILL))).toBe(true);
    expect(read(root, SKILL)).toBe(edited);
    expect(JSON.parse(read(root, CONFIG)).ejected).toBeUndefined();
  });

  it('stages the removal of a committed file when .claude sits one directory below the git root', async () => {
    const { root, edited } = ejectedAndEdited(SKILL);
    const parent = mkdtempSync(join(tmpdir(), 'kit-below-root-'));
    onTestFinished(() => rmSync(parent, { recursive: true, force: true }));
    const nested = join(parent, 'app');
    cpSync(root, nested, { recursive: true });
    rmSync(join(nested, '.git'), { recursive: true, force: true });
    runIn(parent, 'git', ['init', '-q']);
    runIn(parent, 'git', ['add', '-A']);
    runIn(parent, 'git', ['add', '-f', `app/${SKILL}`]);
    runIn(parent, 'git', [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      'commit',
      '-qm',
      'share the skill',
    ]);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    onTestFinished(() => log.mockRestore());

    const status = await inProcess(nested, [SKILL], { shouldUndo: true });

    expect(status).toBe(0);
    expect(log).toHaveBeenCalledWith('Commit the staged removal to finish.');
    expect(stagedChanges(nested)).toBe(`D\tapp/${SKILL}\n`);
    expect(read(nested, SKILL)).toBe(edited);
  });

  it('refuses a file that is not ejected', () => {
    const root = install();
    const config = read(root, CONFIG);
    const result = eject(root, '--undo', SKILL);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not ejected/);
    expect(read(root, CONFIG)).toBe(config);
  });

  it('changes nothing when one of several paths is refused, the index included', () => {
    const { root } = ejectedAndEdited(SKILL);
    runIn(root, 'git', ['add', '-f', SKILL]);
    runIn(root, 'git', ['commit', '-qm', 'share the skill']);
    const config = read(root, CONFIG);
    const gitignore = read(root, GITIGNORE);
    const files = indexFiles(root);

    const result = eject(root, '--undo', SKILL, 'package.json');

    expect(result.status).toBe(1);
    expect(read(root, CONFIG)).toBe(config);
    expect(read(root, GITIGNORE)).toBe(gitignore);
    expect(indexFiles(root)).toBe(files);
    expect(stagedChanges(root)).toBe('');
  });
});

vi.mock('../../ui.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ui.js')>();
  return { ...actual, selectFiles: vi.fn() };
});

const ORCHESTRATE_DIR = '.claude/skills/orchestrate';

function ignoredUnder(root: string, dir: string): string[] {
  return runIn(root, 'git', [
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--',
    dir,
  ])
    .split('\n')
    .filter(Boolean)
    .sort();
}

function snapshot(root: string) {
  return {
    config: read(root, CONFIG),
    gitignore: read(root, GITIGNORE),
    files: indexFiles(root),
  };
}

function inProcess(
  root: string,
  paths: string[],
  options: { shouldUndo?: boolean; yes?: boolean } = {},
): Promise<number> {
  return ejectCommand(
    root,
    paths,
    { shouldUndo: false, yes: false, dryRun: false, ...options },
    '0.0.0',
  );
}

describe('eject with no manifest', () => {
  const MANIFEST = '.claude/houserules.manifest.json';

  it('writes no manifest, and still records the ejection and rewrites the block', () => {
    const root = install();
    rmSync(join(root, MANIFEST));
    const configBefore = read(root, CONFIG);
    const gitignoreBefore = read(root, GITIGNORE);

    const result = eject(root, SKILL);

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(root, MANIFEST))).toBe(false);
    expect(read(root, CONFIG)).toBe(configWith(configBefore, [SKILL]));
    expect(read(root, GITIGNORE)).not.toBe(gitignoreBefore);
    expect(blockLines(root)).not.toContain('/skills/blast-radius/SKILL.md');
  });

  it('writes no manifest on --undo either', () => {
    const root = install();
    expect(eject(root, SKILL).status).toBe(0);
    rmSync(join(root, MANIFEST));

    const result = eject(root, '--undo', SKILL);

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(root, MANIFEST))).toBe(false);
    expect(JSON.parse(read(root, CONFIG)).ejected).toBeUndefined();
  });
});

describe('eject picker', () => {
  afterEach(() => {
    vi.mocked(ui.selectFiles).mockReset();
    vi.restoreAllMocks();
  });

  it('offers the dests under a directory and ejects only the picked ones', async () => {
    const root = install();
    const offered = ignoredUnder(root, ORCHESTRATE_DIR);
    expect(offered.length).toBeGreaterThan(1);
    const picked = offered[0]!;
    vi.mocked(ui.selectFiles).mockResolvedValue([picked]);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const status = await inProcess(root, [ORCHESTRATE_DIR]);

    expect(status).toBe(0);
    expect(vi.mocked(ui.selectFiles).mock.calls[0]![0]).toEqual(offered);
    expect(JSON.parse(read(root, CONFIG)).ejected).toEqual([picked]);
  });

  it('offers every owned dest for a bare eject', async () => {
    const root = install();
    const offered = ignoredUnder(root, '.claude').filter(
      (dest) =>
        !dest.startsWith('.claude/scripts/') &&
        !dest.startsWith('.claude/templates/') &&
        dest !== '.claude/houserules.manifest.json' &&
        dest !== '.claude/settings.local.json',
    );
    vi.mocked(ui.selectFiles).mockResolvedValue([SKILL]);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const status = await inProcess(root, []);

    expect(status).toBe(0);
    expect(vi.mocked(ui.selectFiles).mock.calls[0]![0]).toEqual(offered);
    expect(JSON.parse(read(root, CONFIG)).ejected).toEqual([SKILL]);
  });

  it('offers the ejected dests under a directory for --undo and returns the picked ones', async () => {
    const root = install();
    const [first, second] = ignoredUnder(root, ORCHESTRATE_DIR);
    expect(eject(root, first!, second!).status).toBe(0);
    vi.mocked(ui.selectFiles).mockResolvedValue([second!]);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const status = await inProcess(root, [ORCHESTRATE_DIR], {
      shouldUndo: true,
    });

    expect(status).toBe(0);
    expect(vi.mocked(ui.selectFiles).mock.calls[0]![0]).toEqual([
      first,
      second,
    ]);
    expect(JSON.parse(read(root, CONFIG)).ejected).toEqual([first]);
  });

  it('offers every ejected dest for a bare --undo', async () => {
    const root = install();
    expect(eject(root, SKILL, RULE).status).toBe(0);
    vi.mocked(ui.selectFiles).mockResolvedValue([RULE]);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const status = await inProcess(root, [], { shouldUndo: true });

    expect(status).toBe(0);
    expect(vi.mocked(ui.selectFiles).mock.calls[0]![0]).toEqual([RULE, SKILL]);
    expect(JSON.parse(read(root, CONFIG)).ejected).toEqual([SKILL]);
  });

  it('never opens the picker when a path is refused', async () => {
    const root = install();
    const before = snapshot(root);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const status = await inProcess(root, [ORCHESTRATE_DIR, 'package.json']);

    expect(status).toBe(1);
    expect(ui.selectFiles).not.toHaveBeenCalled();
    expect(snapshot(root)).toEqual(before);
  });
});

describe('eject with no terminal', () => {
  function expectListed(stderr: string, dests: string[]): void {
    const listed = stderr
      .split('\n')
      .filter((line) => line.startsWith('  .claude/'))
      .map((line) => line.trim())
      .sort();
    expect(listed).toEqual(dests);
  }

  it('refuses a directory and lists the dests under it', () => {
    const root = install();
    const before = snapshot(root);

    const result = eject(root, ORCHESTRATE_DIR);

    expect(result.status).toBe(1);
    expectListed(result.stderr, ignoredUnder(root, ORCHESTRATE_DIR));
    expect(snapshot(root)).toEqual(before);
  });

  it('refuses a bare eject and lists every owned dest', () => {
    const root = install();
    const before = snapshot(root);

    const result = eject(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(SKILL);
    expect(result.stderr).toContain(RULE);
    expect(snapshot(root)).toEqual(before);
  });

  it('refuses --yes the same way', () => {
    const root = install();
    const before = snapshot(root);

    const result = eject(root, '--yes', ORCHESTRATE_DIR);

    expect(result.status).toBe(1);
    expectListed(result.stderr, ignoredUnder(root, ORCHESTRATE_DIR));
    expect(snapshot(root)).toEqual(before);
  });

  it('refuses --undo on a directory and lists the ejected dests under it', () => {
    const root = install();
    const [first, second] = ignoredUnder(root, ORCHESTRATE_DIR);
    expect(eject(root, first!, second!).status).toBe(0);
    expect(eject(root, SKILL).status).toBe(0);
    const before = snapshot(root);

    const result = eject(root, '--undo', ORCHESTRATE_DIR);

    expect(result.status).toBe(1);
    expectListed(result.stderr, [first!, second!].sort());
    expect(snapshot(root)).toEqual(before);
  });

  it('refuses a bare --undo and lists every ejected dest', () => {
    const root = install();
    expect(eject(root, SKILL, RULE).status).toBe(0);
    const before = snapshot(root);

    const result = eject(root, '--undo');

    expect(result.status).toBe(1);
    expectListed(result.stderr, [RULE, SKILL]);
    expect(snapshot(root)).toEqual(before);
  });
});

describe('eject across several files', () => {
  it('writes nothing when an accepted path comes before an unowned one', () => {
    const root = install();
    const before = snapshot(root);

    const result = eject(root, SKILL, 'package.json');

    expect(result.status).toBe(1);
    expect(snapshot(root)).toEqual(before);
    expect(stagedChanges(root)).toBe('');
  });

  it('stages nothing on --undo of a committed ejected dest followed by an unowned path', () => {
    const root = install();
    expect(eject(root, SKILL).status).toBe(0);
    runIn(root, 'git', ['add', '-f', SKILL]);
    runIn(root, 'git', ['commit', '-qm', 'share the skill']);
    const before = snapshot(root);

    const result = eject(root, '--undo', SKILL, 'package.json');

    expect(result.status).toBe(1);
    expect(snapshot(root)).toEqual(before);
    expect(stagedChanges(root)).toBe('');
  });
});

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURE_PLUGIN = join(KIT_ROOT, 'test/plugin-fixture');
const FIXTURE_SKILL = '.claude/skills/fixture-skill/SKILL.md';
const TEAM_EDIT = '\nmy team edit\n';
const SHIPPED_BUMP = '\nhouserules shipped a newer line\n';

function ensureFixtureSelfLink(): void {
  const link = join(FIXTURE_PLUGIN, 'node_modules', '@houserules', 'cli');
  if (existsSync(link)) return;
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(KIT_ROOT, link, 'dir');
}

function untrackedFiles(root: string): string[] {
  return runIn(root, 'git', ['status', '--porcelain', '--untracked-files=all'])
    .split('\n')
    .filter((line) => line.startsWith('?? '))
    .map((line) => line.slice('?? '.length));
}

describe('eject, edit, sync and undo on one git repo', () => {
  let pluginCopy: string;

  beforeEach(() => {
    pluginCopy = mkdtempSync(join(tmpdir(), 'kit-eject-seq-plugin-'));
    cpSync(FIXTURE_PLUGIN, pluginCopy, { recursive: true });
  });

  afterEach(() => {
    rmSync(pluginCopy, { recursive: true, force: true });
  });

  it('follows an ejected skill file from untracked through conflict, a fresh clone, and undo', () => {
    ensureFixtureSelfLink();
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'code-cleanliness,fixture/fixture-core',
      plugins: [{ name: FIXTURE_PLUGIN, alias: 'fixture' }],
    });
    editHouseConfig(root, (config) => {
      config.plugins = [{ name: pluginCopy, alias: 'fixture' }];
    });
    expect(ignored(root, FIXTURE_SKILL), 'ignored before eject').toBe(true);

    const ejected = eject(root, FIXTURE_SKILL);

    expect(ejected.status, ejected.stderr).toBe(0);
    expect(untrackedFiles(root), 'untracked after eject').toContain(
      FIXTURE_SKILL,
    );

    appendFileSync(join(root, FIXTURE_SKILL), TEAM_EDIT);
    const edited = read(root, FIXTURE_SKILL);
    const updated = runCli(['update', root]);

    expect(updated.status, updated.stderr).toBe(0);
    expect(read(root, FIXTURE_SKILL), 'edit kept by update').toBe(edited);
    expect(driftFor(runDoctorJson(root), FIXTURE_SKILL)?.status).toBe('yours');

    appendFileSync(
      join(pluginCopy, 'payload-dist/skills/fixture-skill/SKILL.md'),
      SHIPPED_BUMP,
    );
    runCli(['update', root]);

    expect(read(root, FIXTURE_SKILL), 'edit kept after bump').toBe(edited);
    const conflict = driftFor(runDoctorJson(root), FIXTURE_SKILL);
    expect(conflict?.status).toBe('conflict');
    expect(conflict?.diff).toContain('houserules shipped a newer line');

    runIn(root, 'git', ['add', '-f', FIXTURE_SKILL]);
    runIn(root, 'git', ['add', '-A']);
    runIn(root, 'git', ['clean', '-fdX', '-q']);
    expect(existsSync(join(root, '.claude/houserules.manifest.json'))).toBe(
      false,
    );
    const synced = runCli(['update', '--sync', root]);

    expect(synced.status, synced.stderr).toBe(0);
    expect(read(root, FIXTURE_SKILL), 'edit intact after sync').toBe(edited);

    const undone = eject(root, '--undo', FIXTURE_SKILL);

    expect(undone.status, undone.stderr).toBe(0);
    expect(undone.stdout).toContain(`${FIXTURE_SKILL} is ignored again.`);
    expect(indexFiles(root)).not.toContain(FIXTURE_SKILL);
    expect(ignored(root, FIXTURE_SKILL), 'ignored after undo').toBe(true);
    expect(read(root, FIXTURE_SKILL), 'bytes untouched by undo').toBe(edited);
  });

  it('renders configured rule paths into an ignored rule file on update', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'code-cleanliness',
    });
    editHouseConfig(root, (config) => {
      config.rules = { 'code-cleanliness': { paths: ['src/**/*.ts'] } };
    });

    const updated = runCli(['update', root]);

    expect(updated.status, updated.stderr).toBe(0);
    expect(splitFrontmatter(read(root, RULE)).frontmatter).toContain(
      'src/**/*.ts',
    );
    expect(ignored(root, RULE), 'rule still ignored').toBe(true);
  });
});
