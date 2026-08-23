import { beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { runScript } from '#test/run';

const SCRIPT = '.claude/scripts/changeset-write.mjs';
const PLUGIN_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function installChangesets(): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'cs/changesets',
    plugins: [{ name: PLUGIN_ROOT, alias: 'cs' }],
  });
}

// pnpm strict layouts do not hoist transitive deps, so @changesets/write resolves
// through @changesets/cli.
function linkChangesetsCli(root: string): void {
  const cliDir = dirname(
    createRequire(import.meta.url).resolve('@changesets/cli/package.json'),
  );
  mkdirSync(join(root, 'node_modules/@changesets'), { recursive: true });
  symlinkSync(cliDir, join(root, 'node_modules/@changesets/cli'));
}

function newChangesets(root: string, before: Set<string>): string[] {
  return readdirSync(join(root, '.changeset')).filter(
    (f) => f.endsWith('.md') && !before.has(f),
  );
}

function soleNewChangeset(root: string, before: Set<string>): string {
  const [file, ...rest] = newChangesets(root, before);
  if (file === undefined || rest.length > 0) {
    throw new Error(
      `expected exactly one new changeset, found ${JSON.stringify([file, ...rest])}`,
    );
  }
  return file;
}

describe('changeset-write.mjs on a pnpm monorepo', () => {
  let root: string;

  beforeEach(() => {
    root = installChangesets();
    linkChangesetsCli(root);
  });

  it('writes a valid changeset via @changesets/write for known packages', () => {
    const before = new Set(readdirSync(join(root, '.changeset')));

    const r = runScript(root, SCRIPT, {
      args: [
        '--pkg',
        '@fix/cityville:minor',
        '--pkg',
        '@fix/studio',
        '--summary',
        'Add road planning; fixes the zoning bug.',
      ],
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim(), 'human-id filename from @changesets/write').toMatch(
      /^\.changeset\/[a-z][a-z-]*\.md$/,
    );

    const file = soleNewChangeset(root, before);
    const text = readFileSync(join(root, '.changeset', file), 'utf8');
    expect(text, text).toMatch(
      /^---\n['"]@fix\/cityville['"]: minor\n['"]@fix\/studio['"]: patch\n---\n\nAdd road planning/,
    );
  });

  it('rejects an unknown package, naming the packages that do exist', () => {
    const r = runScript(root, SCRIPT, {
      args: ['--pkg', '@fix/nope', '--summary', 'x'],
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Unknown package "@fix\/nope"/);
    expect(r.stderr).toMatch(
      /@fix\/cityville, @fix\/studio|@fix\/studio, @fix\/cityville/,
    );
  });

  it('rejects an invalid --level', () => {
    const r = runScript(root, SCRIPT, {
      args: ['--pkg', '@fix/studio', '--level', 'huge', '--summary', 'x'],
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Invalid --level/);
  });

  it('requires a non-empty --summary when neither a flag nor stdin supplies one', () => {
    const r = runScript(root, SCRIPT, { args: ['--pkg', '@fix/studio'] });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/non-empty --summary/);
  });

  it('refuses a summary carrying a ledger-id-shaped string, writing no file', () => {
    const before = new Set(readdirSync(join(root, '.changeset')));
    const r = runScript(root, SCRIPT, {
      args: [
        '--pkg',
        '@fix/studio',
        '--summary',
        'Fix the bug from STUDIO-a1b2c3.',
      ],
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/STUDIO-a1b2c3/);
    expect(r.stderr).toMatch(/Reword the summary/);
    expect(newChangesets(root, before)).toEqual([]);
  });

  it('refuses an --amend summary carrying a ledger id, leaving the pending changeset unchanged', () => {
    const first = runScript(root, SCRIPT, {
      args: ['--pkg', '@fix/cityville', '--summary', 'Add road planning.'],
    }).stdout.trim();
    const pending = readFileSync(join(root, first), 'utf8');

    const r = runScript(root, SCRIPT, {
      args: ['--amend', first, '--summary', 'Reworked per CITYVILLE-0d9e8f.'],
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/CITYVILLE-0d9e8f/);
    expect(readFileSync(join(root, first), 'utf8')).toBe(pending);
  });

  it('accepts a summary whose id-like tokens do not match the ledger shape', () => {
    const before = new Set(readdirSync(join(root, '.changeset')));
    const r = runScript(root, SCRIPT, {
      args: [
        '--pkg',
        '@fix/studio',
        '--summary',
        'Support SHA-256 digests, fixing the TS2305 import error.',
      ],
    });
    expect(r.status, r.stderr).toBe(0);
    expect(newChangesets(root, before)).toHaveLength(1);
  });

  it('writes a changeset with no package bumps when --empty is passed', () => {
    const before = new Set(readdirSync(join(root, '.changeset')));
    const r = runScript(root, SCRIPT, {
      args: ['--empty', '--summary', 'tooling only — no release'],
    });
    expect(r.status, r.stderr).toBe(0);
    const file = soleNewChangeset(root, before);
    expect(readFileSync(join(root, '.changeset', file), 'utf8')).toMatch(
      /^---\n+---\n+tooling only/,
    );
  });

  it('rewrites the pending changeset in place when --amend names it, adding no second file', () => {
    const first = runScript(root, SCRIPT, {
      args: [
        '--pkg',
        '@fix/cityville:minor',
        '--summary',
        'Add road planning.',
      ],
    }).stdout.trim();
    const before = new Set(readdirSync(join(root, '.changeset')));

    const r = runScript(root, SCRIPT, {
      args: [
        '--amend',
        first,
        '--summary',
        'Add road planning with zoning overlays.',
      ],
    });

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(first);
    expect(newChangesets(root, before)).toEqual([]);
    expect(readFileSync(join(root, first), 'utf8')).toMatch(
      /['"]@fix\/cityville['"]: minor\n---\n\nAdd road planning with zoning overlays\./,
    );
  });

  it('keeps the packages the amended changeset already declared', () => {
    const first = runScript(root, SCRIPT, {
      args: [
        '--pkg',
        '@fix/cityville:minor',
        '--summary',
        'Add road planning.',
      ],
    }).stdout.trim();

    runScript(root, SCRIPT, {
      args: ['--amend', first, '--pkg', '@fix/studio', '--summary', 'Grown.'],
    });

    const text = readFileSync(join(root, first), 'utf8');
    expect(text, text).toMatch(/['"]@fix\/cityville['"]: minor/);
    expect(text, text).toMatch(/['"]@fix\/studio['"]: patch/);
  });

  it('raises the bump when --amend passes a higher level than the pending one', () => {
    const first = runScript(root, SCRIPT, {
      args: ['--pkg', '@fix/studio:patch', '--summary', 'Fix a typo.'],
    }).stdout.trim();

    runScript(root, SCRIPT, {
      args: [
        '--amend',
        first,
        '--pkg',
        '@fix/studio:minor',
        '--summary',
        'Add a panel.',
      ],
    });

    expect(readFileSync(join(root, first), 'utf8')).toMatch(
      /['"]@fix\/studio['"]: minor/,
    );
  });

  it('never lowers a bump the pending changeset already declared', () => {
    const first = runScript(root, SCRIPT, {
      args: ['--pkg', '@fix/studio:minor', '--summary', 'Add a panel.'],
    }).stdout.trim();

    runScript(root, SCRIPT, {
      args: [
        '--amend',
        first,
        '--pkg',
        '@fix/studio:patch',
        '--summary',
        'Add a panel and fix its label.',
      ],
    });

    expect(readFileSync(join(root, first), 'utf8')).toMatch(
      /['"]@fix\/studio['"]: minor/,
    );
  });

  it("absorbs a second changeset's packages into the survivor and deletes the absorbed file", () => {
    const first = runScript(root, SCRIPT, {
      args: [
        '--pkg',
        '@fix/cityville:minor',
        '--summary',
        'Add road planning.',
      ],
    }).stdout.trim();
    const second = runScript(root, SCRIPT, {
      args: ['--pkg', '@fix/studio:patch', '--summary', 'Fix a typo.'],
    }).stdout.trim();
    const before = new Set(readdirSync(join(root, '.changeset')));

    const r = runScript(root, SCRIPT, {
      args: [
        '--amend',
        first,
        '--absorb',
        second,
        '--summary',
        'Add road planning and fix a typo.',
      ],
    });

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(first);
    expect(newChangesets(root, before)).toEqual([]);
    expect(existsSync(join(root, second)), 'absorbed file is deleted').toBe(
      false,
    );
    const text = readFileSync(join(root, first), 'utf8');
    expect(text, text).toMatch(/['"]@fix\/cityville['"]: minor/);
    expect(text, text).toMatch(/['"]@fix\/studio['"]: patch/);
  });

  it('takes the higher bump when the survivor and an absorbed changeset name the same package at different levels', () => {
    const first = runScript(root, SCRIPT, {
      args: ['--pkg', '@fix/studio:patch', '--summary', 'Fix a typo.'],
    }).stdout.trim();
    const second = runScript(root, SCRIPT, {
      args: ['--pkg', '@fix/studio:major', '--summary', 'Rework the API.'],
    }).stdout.trim();

    const r = runScript(root, SCRIPT, {
      args: [
        '--amend',
        first,
        '--absorb',
        second,
        '--summary',
        'Rework the API.',
      ],
    });

    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(root, first), 'utf8')).toMatch(
      /['"]@fix\/studio['"]: major/,
    );
  });

  it('absorbs more than one changeset in a single call', () => {
    const first = runScript(root, SCRIPT, {
      args: ['--pkg', '@fix/cityville:patch', '--summary', 'Fix a typo.'],
    }).stdout.trim();
    const second = runScript(root, SCRIPT, {
      args: ['--pkg', '@fix/studio:patch', '--summary', 'Fix another typo.'],
    }).stdout.trim();
    const third = runScript(root, SCRIPT, {
      args: ['--pkg', '@fix/studio:minor', '--summary', 'Add a panel.'],
    }).stdout.trim();

    const r = runScript(root, SCRIPT, {
      args: [
        '--amend',
        first,
        '--absorb',
        second,
        '--absorb',
        third,
        '--summary',
        'Fix typos and add a panel.',
      ],
    });

    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, second))).toBe(false);
    expect(existsSync(join(root, third))).toBe(false);
    const text = readFileSync(join(root, first), 'utf8');
    expect(text, text).toMatch(/['"]@fix\/cityville['"]: patch/);
    expect(text, text).toMatch(/['"]@fix\/studio['"]: minor/);
  });

  it('absorbs a release-free changeset, which contributes no bumps and still disappears', () => {
    const first = runScript(root, SCRIPT, {
      args: ['--pkg', '@fix/studio:patch', '--summary', 'Fix a typo.'],
    }).stdout.trim();
    const second = runScript(root, SCRIPT, {
      args: ['--empty', '--summary', 'tooling only — no release'],
    }).stdout.trim();

    const r = runScript(root, SCRIPT, {
      args: ['--amend', first, '--absorb', second, '--summary', 'Fix a typo.'],
    });

    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, second))).toBe(false);
    expect(readFileSync(join(root, first), 'utf8')).toMatch(
      /['"]@fix\/studio['"]: patch/,
    );
  });

  it('rejects --absorb with no --amend, writing and deleting nothing', () => {
    const first = runScript(root, SCRIPT, {
      args: ['--pkg', '@fix/studio:patch', '--summary', 'Fix a typo.'],
    }).stdout.trim();
    const before = readdirSync(join(root, '.changeset')).sort();

    const r = runScript(root, SCRIPT, {
      args: ['--absorb', first, '--summary', 'x'],
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--absorb requires --amend/);
    expect(readdirSync(join(root, '.changeset')).sort()).toEqual(before);
  });

  it('rejects --absorb naming the amend target, writing and deleting nothing', () => {
    const first = runScript(root, SCRIPT, {
      args: ['--pkg', '@fix/studio:patch', '--summary', 'Fix a typo.'],
    }).stdout.trim();
    const before = readdirSync(join(root, '.changeset')).sort();

    const r = runScript(root, SCRIPT, {
      args: ['--amend', first, '--absorb', first, '--summary', 'x'],
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Cannot absorb/);
    expect(readdirSync(join(root, '.changeset')).sort()).toEqual(before);
  });

  it('rejects --empty combined with --absorb', () => {
    const first = runScript(root, SCRIPT, {
      args: ['--pkg', '@fix/studio:patch', '--summary', 'Fix a typo.'],
    }).stdout.trim();
    const second = runScript(root, SCRIPT, {
      args: ['--pkg', '@fix/cityville:patch', '--summary', 'Fix another.'],
    }).stdout.trim();
    const before = readdirSync(join(root, '.changeset')).sort();

    const r = runScript(root, SCRIPT, {
      args: ['--amend', first, '--absorb', second, '--empty', '--summary', 'x'],
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--empty cannot be combined with --absorb/);
    expect(readdirSync(join(root, '.changeset')).sort()).toEqual(before);
  });

  it("rejects an absorbed id with no file, leaving the survivor's summary intact", () => {
    const first = runScript(root, SCRIPT, {
      args: ['--pkg', '@fix/studio:patch', '--summary', 'Original summary.'],
    }).stdout.trim();
    const before = readdirSync(join(root, '.changeset')).sort();

    const r = runScript(root, SCRIPT, {
      args: [
        '--amend',
        first,
        '--absorb',
        'no-such-changeset',
        '--summary',
        'Would replace it.',
      ],
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/No pending changeset at \.changeset\//);
    expect(readdirSync(join(root, '.changeset')).sort()).toEqual(before);
    expect(readFileSync(join(root, first), 'utf8')).toMatch(
      /Original summary\./,
    );
  });

  it('rejects --amend for a changeset that does not exist', () => {
    const r = runScript(root, SCRIPT, {
      args: ['--amend', 'no-such-changeset', '--summary', 'x'],
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/No pending changeset at \.changeset\//);
  });

  it('rejects --amend on the .changeset README', () => {
    const r = runScript(root, SCRIPT, {
      args: ['--amend', 'README.md', '--summary', 'x'],
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not a changeset id/);
  });

  it('reads the summary from stdin when --summary is not passed', () => {
    const before = new Set(readdirSync(join(root, '.changeset')));
    const r = runScript(root, SCRIPT, {
      args: ['--pkg', '@fix/studio'],
      input: 'Summary via stdin.\n',
    });
    expect(r.status, r.stderr).toBe(0);
    const file = soleNewChangeset(root, before);
    expect(readFileSync(join(root, '.changeset', file), 'utf8')).toMatch(
      /['"]@fix\/studio['"]: patch[\s\S]*Summary via stdin\./,
    );
  });
});

describe('changeset-write.mjs outcome record', () => {
  let root: string;

  beforeEach(() => {
    root = installChangesets();
    linkChangesetsCli(root);
  });

  function records(): {
    ts: string;
    file: string;
    action: string;
    chat?: string;
  }[] {
    return readFileSync(join(root, '.claude/state/changesets.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  }

  it('stamps one record line with the created file and the --chat id', () => {
    const before = new Set(readdirSync(join(root, '.changeset')));

    const r = runScript(root, SCRIPT, {
      args: [
        '--pkg',
        '@fix/studio',
        '--summary',
        'Record me.',
        '--chat',
        'session-abc',
      ],
    });

    expect(r.status, r.stderr).toBe(0);
    expect(records()).toEqual([
      {
        ts: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as string,
        file: soleNewChangeset(root, before),
        action: 'add',
        chat: 'session-abc',
      },
    ]);
  });

  it('records an amend under the surviving filename, omitting chat when not passed', () => {
    const before = new Set(readdirSync(join(root, '.changeset')));
    const first = runScript(root, SCRIPT, {
      args: ['--pkg', '@fix/studio', '--summary', 'First.'],
    });
    expect(first.status, first.stderr).toBe(0);
    const file = soleNewChangeset(root, before);

    const r = runScript(root, SCRIPT, {
      args: ['--amend', file.replace(/\.md$/, ''), '--summary', 'Rewritten.'],
    });

    expect(r.status, r.stderr).toBe(0);
    const [, second] = records();
    expect(second).toEqual({
      ts: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as string,
      file,
      action: 'amend',
    });
  });

  it('warns without failing the changeset when the record cannot be written', () => {
    const before = new Set(readdirSync(join(root, '.changeset')));
    mkdirSync(join(root, '.claude/state/changesets.jsonl'), {
      recursive: true,
    });

    const r = runScript(root, SCRIPT, {
      args: ['--pkg', '@fix/studio', '--summary', 'Still written.'],
    });

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/could not record the changeset outcome/);
    expect(newChangesets(root, before)).toHaveLength(1);
  });
});

describe('changeset-write.mjs on a single-package repo', () => {
  it('defaults --pkg to the root package, seeding .changeset/config.json first', () => {
    const root = useInstalledRepo('npm-single', {
      modules: 'cs/changesets',
      plugins: [{ name: PLUGIN_ROOT, alias: 'cs' }],
    });
    expect(
      existsSync(join(root, '.changeset/config.json')),
      'config seeded for repo without one',
    ).toBeTruthy();
    linkChangesetsCli(root);
    const r = runScript(root, SCRIPT, {
      args: ['--summary', 'First release note.'],
    });
    expect(r.status, r.stderr).toBe(0);
    const file = r.stdout.trim();
    expect(readFileSync(join(root, file), 'utf8')).toMatch(
      /['"]single-app['"]: patch/,
    );
  });
});

describe('changeset-write.mjs without @changesets/write resolvable', () => {
  it('refuses to author and writes no file, with an actionable install command', () => {
    const root = installChangesets();
    const before = new Set(readdirSync(join(root, '.changeset')));

    const r = runScript(root, SCRIPT, {
      args: ['--pkg', '@fix/studio', '--summary', 'Should never be written.'],
    });
    expect(r.status, r.stdout).toBe(1);
    expect(r.stderr).toMatch(/@changesets\/write is not resolvable/);
    expect(r.stderr, 'actionable install command').toMatch(/pnpm add -D/);
    expect(
      newChangesets(root, before).length,
      'no changeset file may be created without the official writer',
    ).toBe(0);
  });
});
