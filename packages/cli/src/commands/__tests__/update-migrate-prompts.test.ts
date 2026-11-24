import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';
import { appendFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { Flags } from '../../cli-contract.js';
import type { MigrationChoice } from '../../core/migration-preverify.js';
import { editHouseConfig } from '#test/installed-tree';
import { prepareInstalledRepo, useInstalledRepo } from '#test/repo';
import { runIn } from '#test/run';
import * as ui from '../../ui.js';
import { update } from '../update.js';

vi.mock('../../ui.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ui.js')>();
  return { ...actual, chooseMigrationOption: vi.fn() };
});

const CONFIG = '.claude/houserules.config.json';
const MANIFEST = '.claude/houserules.manifest.json';
const GITIGNORE = '.claude/.gitignore';
const EDITED_SKILL = '.claude/skills/tidy/SKILL.md';
const OTHER_SKILL = '.claude/skills/ready/SKILL.md';
const EDIT = '\nmy team edit\n';

interface Snapshot {
  staged: string;
  tracked: string;
  config: string;
}

function git(root: string, ...args: string[]): string {
  return runIn(root, 'git', args);
}

function snapshot(root: string): Snapshot {
  return {
    staged: git(root, 'diff', '--cached', '--name-status', '--relative'),
    tracked: git(root, 'ls-files', '--', '.claude'),
    config: readFileSync(join(root, CONFIG), 'utf8'),
  };
}

const INSTALL_SHAPE = 'npm-single';
const INSTALL_OPTIONS = { modules: 'code-cleanliness,ready,orchestrate' };

function committedInstall(): string {
  const root = useInstalledRepo(INSTALL_SHAPE, INSTALL_OPTIONS);
  editHouseConfig(root, (current) => {
    delete current.modules;
  });
  git(root, 'add', '-f', '.claude');
  git(root, 'commit', '-qm', 'committed install');
  return root;
}

function trackedPayload(root: string): string[] {
  return git(root, 'ls-files', '--', '.claude')
    .split('\n')
    .filter(Boolean)
    .filter((dest) => dest !== MANIFEST && dest !== GITIGNORE);
}

function massMisreadInstall(): string {
  const root = committedInstall();
  for (const dest of trackedPayload(root)) {
    if (dest.startsWith('.claude/skills/') && dest.endsWith('.md')) {
      appendFileSync(join(root, dest), EDIT);
    }
  }
  return root;
}

function manifestDisagreesInstall(): string {
  const root = committedInstall();
  rmSync(join(root, OTHER_SKILL));
  return root;
}

function stagedEditInstall(): string {
  const root = committedInstall();
  appendFileSync(join(root, EDITED_SKILL), EDIT);
  git(root, 'add', '--', EDITED_SKILL);
  return root;
}

function flagsWith(overrides: Partial<Flags>): Flags {
  return {
    dryRun: false,
    yes: false,
    modules: '',
    force: false,
    nextSteps: false,
    disable: '',
    reconfigure: '',
    fix: false,
    prune: false,
    json: false,
    kitVersion: '0.0.0',
    ...overrides,
  };
}

const chooseMock = vi.mocked(ui.chooseMigrationOption);

function answerWith(root: string, before: Snapshot, choice: MigrationChoice) {
  chooseMock.mockImplementation(async () => {
    expect(snapshot(root), 'state at the prompt').toEqual(before);
    return choice;
  });
}

let errors: ReturnType<typeof vi.spyOn>;
let printed: ReturnType<typeof vi.spyOn>;

function output(): string {
  return [...errors.mock.calls, ...printed.mock.calls]
    .map((call) => call.join(' '))
    .join('\n');
}

beforeAll(() => {
  prepareInstalledRepo(INSTALL_SHAPE, INSTALL_OPTIONS);
});

beforeEach(() => {
  chooseMock.mockReset();
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  printed = vi.spyOn(console, 'log').mockImplementation(() => {});
  onTestFinished(() => {
    errors.mockRestore();
    printed.mockRestore();
  });
});

describe.each([
  { finding: 'mass misread', install: massMisreadInstall },
  { finding: 'manifest disagrees', install: manifestDisagreesInstall },
])('update on a $finding finding with a terminal', ({ install }) => {
  it('exits 1 on stop and leaves the index and config as they were', async () => {
    const root = install();
    const before = snapshot(root);
    answerWith(root, before, 'stop');

    const status = await update(root, flagsWith({}));

    expect(status).toBe(1);
    expect(chooseMock).toHaveBeenCalledTimes(1);
    expect(snapshot(root)).toEqual(before);
  });

  it('proceeds and exits 0 on force', async () => {
    const root = install();
    answerWith(root, snapshot(root), 'force');

    const status = await update(root, flagsWith({}));

    expect(status).toBe(0);
    expect(chooseMock).toHaveBeenCalledTimes(1);
  });

  it('proceeds and exits 0 on eject-all', async () => {
    const root = install();
    answerWith(root, snapshot(root), 'eject-all');

    const status = await update(root, flagsWith({}));

    expect(status).toBe(0);
    expect(chooseMock).toHaveBeenCalledTimes(1);
  });
});

describe('update on a mass misread finding, by answer', () => {
  it('ejects the edited files on eject-all and untracks nothing it ejected', async () => {
    const root = massMisreadInstall();
    answerWith(root, snapshot(root), 'eject-all');

    await update(root, flagsWith({}));

    expect(
      git(root, 'ls-files', '--', EDITED_SKILL).trim(),
      'edited skill tracked',
    ).toBe(EDITED_SKILL);
    expect(readFileSync(join(root, CONFIG), 'utf8')).toContain(EDITED_SKILL);
  });

  it('writes nothing to the ejected list on force', async () => {
    const root = massMisreadInstall();
    answerWith(root, snapshot(root), 'force');

    await update(root, flagsWith({}));

    expect(readFileSync(join(root, CONFIG), 'utf8')).not.toContain('ejected');
  });
});

describe('update on a staged finding with a terminal', () => {
  it('exits 1 without asking and leaves the index and config as they were', async () => {
    const root = stagedEditInstall();
    const before = snapshot(root);

    const status = await update(root, flagsWith({}));

    expect(status).toBe(1);
    expect(chooseMock).not.toHaveBeenCalled();
    expect(snapshot(root)).toEqual(before);
    expect(output()).toContain(EDITED_SKILL);
  });
});

describe.each([
  { flag: 'force', overrides: { force: true } },
  { flag: 'ejectAll', overrides: { ejectAll: true } },
])('update with $flag and no terminal', ({ overrides }) => {
  it.each([
    { finding: 'mass misread', install: massMisreadInstall },
    { finding: 'manifest disagrees', install: manifestDisagreesInstall },
  ])('proceeds with no prompt on $finding', async ({ install }) => {
    const root = install();

    const status = await update(root, flagsWith({ yes: true, ...overrides }));

    expect(status).toBe(0);
    expect(chooseMock).not.toHaveBeenCalled();
    expect(git(root, 'ls-files', '--', MANIFEST).trim()).toBe('');
  });
});

describe('update with no terminal and no flag', () => {
  it.each([
    { finding: 'mass misread', install: massMisreadInstall },
    { finding: 'manifest disagrees', install: manifestDisagreesInstall },
  ])(
    'exits 1 on $finding, names both flags, and changes nothing',
    async ({ install }) => {
      const root = install();
      const before = snapshot(root);

      const status = await update(root, flagsWith({ yes: true }));

      expect(status).toBe(1);
      expect(chooseMock).not.toHaveBeenCalled();
      expect(snapshot(root)).toEqual(before);
      const text = output();
      expect(text).toContain('--force');
      expect(text).toContain('--eject-all');
      expect(text).toContain('No terminal to ask on');
    },
  );
});
