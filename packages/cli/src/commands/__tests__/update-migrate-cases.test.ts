import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { driftFor, runDoctorJson } from '#test/doctor-report';
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

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURE_PLUGIN = join(KIT_ROOT, 'test/plugin-fixture');
const FIXTURE_SKILL = '.claude/skills/fixture-skill/SKILL.md';
const FIXTURE_RULE = '.claude/rules/fixture-rule.md';
const EDITED_SKILL = '.claude/skills/tidy/SKILL.md';
const RULE = '.claude/rules/code-cleanliness.md';
const RULE_ID = 'code-cleanliness';
const MANIFEST = '.claude/houserules.manifest.json';
const CONFIG = '.claude/houserules.config.json';
const GITIGNORE = '.claude/.gitignore';
const BACKUP_IGNORE = '.claude/backups/.gitignore';
const BACKUP_SETTINGS = '.claude/backups/settings.json.bak';
const BACKUP_CONFIG = '.claude/backups/houserules.config.json.bak';
const UNTRACKED_EDITS = [
  '.claude/fixture-file.txt',
  '.claude/fixture-lang-alpha.md',
  '.claude/fixture-write.md',
];
const KEPT_PATHS = ['**/*.ts', '**/*.mts'];
const EDIT = '\nmy team edit\n';
const BUMP = '\nhouserules shipped a newer line\n';
const OLDER_KIT_LINE = '\nolder kit line\n';
const TEAM_KEY = 'team: ours\n';
const FORCE_LINE = 'update --force';
const FORMATTER_CAUSE = 'A repo-wide formatter run is the likely cause.';

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

function indexState(root: string): string {
  return git(root, 'ls-files', '--stage');
}

function stagedChanges(root: string): string {
  return git(root, 'diff', '--cached', '--name-status', '--relative');
}

function unwrapped(text: string): string {
  return text.replace(/[\s│]+/g, ' ');
}

function update(root: string, ...args: string[]): RunResult {
  return runCli(['update', ...args, root]);
}

function updateOk(root: string, ...args: string[]): RunResult {
  const result = update(root, ...args);
  expect(result.status, result.stderr + result.stdout).toBe(0);
  return result;
}

function ensureFixtureSelfLink(): void {
  const link = join(FIXTURE_PLUGIN, 'node_modules', '@houserules', 'cli');
  if (existsSync(link)) return;
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(KIT_ROOT, link, 'dir');
}

function installedRepo(): string {
  ensureFixtureSelfLink();
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'ready,code-cleanliness,fixture/fixture-core',
    plugins: [{ name: FIXTURE_PLUGIN, alias: 'fixture' }],
  });
}

function commitInstall(root: string): void {
  git(root, 'add', '-f', '.claude');
  git(root, 'commit', '-qm', 'committed install');
}

function edit(root: string, dest: string, text = EDIT): string {
  appendFileSync(join(root, dest), text);
  return read(root, dest);
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

function addFrontmatterKey(root: string, dest: string): string {
  const { frontmatter, body } = splitFrontmatter(read(root, dest));
  const edited = frontmatter.replace(/^---\n/, `---\n${TEAM_KEY}`);
  writeFileSync(join(root, dest), edited + body);
  return edited;
}

function blockDests(root: string): string[] {
  return read(root, GITIGNORE)
    .split('\n')
    .filter((line) => line.startsWith('/'))
    .map((line) => `.claude${line}`);
}

function classifiedDests(root: string): string[] {
  return blockDests(root)
    .filter((dest) => dest !== MANIFEST)
    .filter((dest) => existsSync(join(root, dest)))
    .sort();
}

function committedInstall(arrange: (root: string) => void): string {
  const root = installedRepo();
  arrange(root);
  commitInstall(root);
  return root;
}

function legacyRuleEntry(root: string, dest: string): void {
  const manifest = manifestOf(root);
  manifest.files[dest] = sha256(read(root, dest));
  writeManifest(root, manifest);
}

function olderKitFile(root: string, dest: string, isMisread: boolean): void {
  const older = edit(root, dest, OLDER_KIT_LINE);
  const manifest = manifestOf(root);
  manifest.files[dest] = sha256(isMisread ? `${older}lost` : older);
  writeManifest(root, manifest);
}

function commitBackups(root: string): void {
  mkdirSync(join(root, '.claude/backups'), { recursive: true });
  writeFileSync(join(root, BACKUP_IGNORE), '*\n');
  writeFileSync(join(root, BACKUP_SETTINGS), '{ "pre": "kit" }\n');
  git(root, 'add', '-f', '.claude/backups');
  git(root, 'commit', '-qm', 'committed backups');
}

describe('update migrating a committed install, file by file', () => {
  it('ejects an edited skill and keeps it tracked with its edit', () => {
    let edited = '';
    const root = committedInstall((tree) => {
      edited = edit(tree, EDITED_SKILL);
    });

    updateOk(root);

    expect(configOf(root).ejected).toEqual([EDITED_SKILL]);
    expect(isTracked(root, EDITED_SKILL), 'edited skill tracked').toBe(true);
    expect(read(root, EDITED_SKILL)).toBe(edited);
  });

  it('moves a rule whose only edit is a trimmed `paths:` into the config and untracks it', () => {
    let trimmed = '';
    const root = committedInstall((tree) => {
      trimmed = trimRulePaths(tree);
    });

    updateOk(root);

    expect(configOf(root).rules?.[RULE_ID]?.paths).toEqual(KEPT_PATHS);
    expect(configOf(root).ejected).toBeUndefined();
    expect(isTracked(root, RULE), 'rule untracked').toBe(false);
    expect(splitFrontmatter(read(root, RULE)).frontmatter).toBe(trimmed);
  });

  it('ejects a rule with a body edit and a trimmed `paths:`, leaving its `paths:` in the file and no rules entry', () => {
    let edited = '';
    const root = committedInstall((tree) => {
      trimRulePaths(tree);
      edited = edit(tree, RULE);
    });

    updateOk(root);

    expect(configOf(root).ejected).toEqual([RULE]);
    expect(configOf(root).rules).toBeUndefined();
    expect(isTracked(root, RULE), 'rule tracked').toBe(true);
    expect(read(root, RULE)).toBe(edited);
  });

  it('ejects a rule whose frontmatter gained a key other than `paths:`', () => {
    const root = committedInstall((tree) => {
      addFrontmatterKey(tree, RULE);
    });

    updateOk(root);

    expect(configOf(root).ejected).toEqual([RULE]);
    expect(configOf(root).rules).toBeUndefined();
    expect(isTracked(root, RULE), 'rule tracked').toBe(true);
  });

  it('keeps the bytes of a rule ejected for a non-`paths` frontmatter edit on a second update', () => {
    let edited = '';
    const root = committedInstall((tree) => {
      addFrontmatterKey(tree, RULE);
      edited = read(tree, RULE);
    });
    updateOk(root);

    updateOk(root);

    expect(read(root, RULE)).toBe(edited);
    expect(configOf(root).ejected).toEqual([RULE]);
  });

  it('gives an untouched rule on a manifest with no recorded frontmatter hash no rules entry', () => {
    const root = committedInstall((tree) => {
      legacyRuleEntry(tree, RULE);
    });
    expect(typeof manifestOf(root).files[RULE], 'legacy entry staged').toBe(
      'string',
    );

    updateOk(root);

    expect(configOf(root).rules).toBeUndefined();
    expect(configOf(root).ejected).toBeUndefined();
    expect(isTracked(root, RULE), 'rule untracked').toBe(false);
  });
});

describe('update migrating a committed install, given a skill in conflict with a newer shipped copy', () => {
  let pluginCopy: string;

  beforeEach(() => {
    pluginCopy = mkdtempSync(join(tmpdir(), 'kit-migrate-plugin-'));
    cpSync(FIXTURE_PLUGIN, pluginCopy, { recursive: true });
  });

  afterEach(() => {
    rmSync(pluginCopy, { recursive: true, force: true });
  });

  it('ejects the conflict file and keeps its edit tracked', () => {
    let edited = '';
    const root = committedInstall((tree) => {
      editHouseConfig(tree, (config) => {
        config.plugins = [{ name: pluginCopy, alias: 'fixture' }];
      });
      edited = edit(tree, FIXTURE_SKILL);
    });
    appendFileSync(
      join(pluginCopy, 'payload-dist/skills/fixture-skill/SKILL.md'),
      BUMP,
    );
    expect(
      driftFor(runDoctorJson(root), FIXTURE_SKILL)?.status,
      'fixture skill staged as a conflict',
    ).toBe('conflict');

    updateOk(root);

    expect(configOf(root).ejected).toEqual([FIXTURE_SKILL]);
    expect(isTracked(root, FIXTURE_SKILL), 'conflict file tracked').toBe(true);
    expect(read(root, FIXTURE_SKILL)).toBe(edited);
  });
});

describe('update migrating a committed install where every classified file was reformatted', () => {
  interface Reformatted {
    root: string;
    edited: string[];
    fixtureRuleBody: string;
    fixtureRuleFrontmatter: string;
    tidyBody: string;
  }

  function reformattedInstall(): Reformatted {
    const root = installedRepo();
    const tidyBody = read(root, EDITED_SKILL);
    const fixtureRuleBody = splitFrontmatter(read(root, FIXTURE_RULE)).body;
    const reformatted = classifiedDests(root).filter((dest) => dest !== RULE);
    for (const dest of reformatted) edit(root, dest, '\n');
    const fixtureRuleFrontmatter = addFrontmatterKey(root, FIXTURE_RULE);
    trimRulePaths(root);
    rmSync(join(root, '.prettierignore'), { force: true });
    commitInstall(root);
    git(root, 'rm', '--cached', '-q', '--', ...UNTRACKED_EDITS);
    git(root, 'commit', '-qm', 'untrack the edits outside the classified set');
    const edited = reformatted.filter(
      (dest) => !UNTRACKED_EDITS.includes(dest),
    );
    return { root, edited, fixtureRuleBody, fixtureRuleFrontmatter, tidyBody };
  }

  it('stages a fixture where more than half of the classified set reads as edited', () => {
    const { root, edited } = reformattedInstall();

    expect(edited.length * 2, 'edited share').toBeGreaterThan(
      classifiedDests(root).filter((dest) => isTracked(root, dest)).length,
    );
  });

  it('under --force overwrites the edited bodies and keeps the edited rule frontmatter', () => {
    const { root, fixtureRuleBody, fixtureRuleFrontmatter, tidyBody } =
      reformattedInstall();

    updateOk(root, '--force');

    expect(read(root, EDITED_SKILL)).toBe(tidyBody);
    expect(read(root, FIXTURE_RULE)).toBe(
      fixtureRuleFrontmatter + fixtureRuleBody,
    );
  });

  it('under --force ejects nothing, moves the trimmed `paths:` into the config, and untracks the set', () => {
    const { root } = reformattedInstall();
    const classified = classifiedDests(root);

    updateOk(root, '--force');

    expect(configOf(root).ejected).toBeUndefined();
    expect(configOf(root).rules?.[RULE_ID]?.paths).toEqual(KEPT_PATHS);
    expect(
      [...classified, MANIFEST].filter((dest) => isTracked(root, dest)),
    ).toEqual([]);
  });

  it('under --eject-all ejects every edited file and keeps each tracked', () => {
    const { root, edited } = reformattedInstall();

    updateOk(root, '--eject-all');

    expect(configOf(root).ejected).toEqual(edited);
    expect(edited.filter((dest) => !isTracked(root, dest))).toEqual([]);
    expect(configOf(root).rules?.[RULE_ID]?.paths).toEqual(KEPT_PATHS);
  });

  it.each(['--force', '--eject-all'])(
    'under %s leaves the formatter hint without its own `update --force` line',
    (flag) => {
      const { root } = reformattedInstall();

      const output = unwrapped(updateOk(root, flag).stdout);

      expect(output).not.toContain(FORCE_LINE);
    },
  );

  it('under --eject-all still prints the formatter hint for the edited files outside the classified set', () => {
    const { root } = reformattedInstall();

    const output = unwrapped(updateOk(root, '--eject-all').stdout);

    expect(output).toContain(FORMATTER_CAUSE);
  });

  it('with no flag and no terminal exits 1 and leaves the index and the config unchanged', () => {
    const { root } = reformattedInstall();
    const index = indexState(root);
    const staged = stagedChanges(root);
    const config = read(root, CONFIG);

    const result = update(root);

    expect(result.status, result.stdout).toBe(1);
    expect(indexState(root)).toBe(index);
    expect(stagedChanges(root)).toBe(staged);
    expect(read(root, CONFIG)).toBe(config);
  });
});

describe('update migrating an older-kit install where fewer than half of the classified set reads as edited', () => {
  const MISREAD = [FIXTURE_SKILL, EDITED_SKILL];

  function olderKitInstall(): string {
    return committedInstall((tree) => {
      for (const dest of classifiedDests(tree)) {
        if (dest.startsWith('.claude/rules/')) continue;
        olderKitFile(tree, dest, MISREAD.includes(dest));
      }
    });
  }

  it('stages a fixture under the mass-misread threshold', () => {
    const root = olderKitInstall();

    expect(MISREAD.length * 2, 'misread share').toBeLessThan(
      classifiedDests(root).length,
    );
  });

  it('raises nothing and ejects the misread files', () => {
    const root = olderKitInstall();

    updateOk(root);

    expect(configOf(root).ejected).toEqual(MISREAD);
  });

  it('names each misread file in its summary', () => {
    const root = olderKitInstall();

    const output = unwrapped(updateOk(root).stdout);

    expect(output).toContain(
      `ejected 2 edited file(s), which stay committed as yours: ${MISREAD.join(' ')}`,
    );
  });

  it('lets `eject --undo` return one misread file to the ignored set', () => {
    const root = olderKitInstall();
    updateOk(root);

    const result = runCli(['--cwd', root, 'eject', '--undo', EDITED_SKILL]);

    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(configOf(root).ejected).toEqual([FIXTURE_SKILL]);
    expect(blockDests(root)).toContain(EDITED_SKILL);
    expect(isTracked(root, EDITED_SKILL), 'returned file untracked').toBe(
      false,
    );
  });
});

describe('update migrating a committed install with a committed backup directory', () => {
  function backedUpInstall(): string {
    const root = committedInstall(() => {});
    commitBackups(root);
    return root;
  }

  it('removes every backup file from the index, its own `.gitignore` included', () => {
    const root = backedUpInstall();

    updateOk(root);

    expect(git(root, 'status', '--porcelain', '--', '.claude/backups')).toBe(
      `D  ${BACKUP_IGNORE}\nD  ${BACKUP_CONFIG}\nD  ${BACKUP_SETTINGS}\n`,
    );
  });

  it('keeps the backup files on disk', () => {
    const root = backedUpInstall();

    updateOk(root);

    expect(read(root, BACKUP_IGNORE)).toBe('*\n');
    expect(read(root, BACKUP_SETTINGS)).toBe('{ "pre": "kit" }\n');
  });

  it('under --dry-run reports the backups and leaves the index unchanged', () => {
    const root = backedUpInstall();
    const index = indexState(root);

    const output = unwrapped(updateOk(root, '--dry-run').stdout);

    expect(indexState(root)).toBe(index);
    expect(output).toContain(
      'backups: 3 committed backup file(s) would be untracked from git (kept on disk).',
    );
  });

  it('under --sync leaves the backups tracked', () => {
    const root = backedUpInstall();
    const index = indexState(root);

    expect(runCli(['update', '--sync', root]).status).toBe(0);

    expect(indexState(root)).toBe(index);
  });
});
