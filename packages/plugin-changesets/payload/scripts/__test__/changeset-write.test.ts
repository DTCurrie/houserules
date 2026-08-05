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
        'Add road planning; fixes CITYVILLE-abc123.',
      ],
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim(), 'human-id filename from @changesets/write').toMatch(
      /^\.changeset\/[a-z][a-z-]*\.md$/,
    );

    const [file] = newChangesets(root, before);
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

  it('writes a changeset with no package bumps when --empty is passed', () => {
    const before = new Set(readdirSync(join(root, '.changeset')));
    const r = runScript(root, SCRIPT, {
      args: ['--empty', '--summary', 'tooling only — no release'],
    });
    expect(r.status, r.stderr).toBe(0);
    const [file] = newChangesets(root, before);
    expect(readFileSync(join(root, '.changeset', file), 'utf8')).toMatch(
      /^---\n+---\n+tooling only/,
    );
  });

  it('rewrites the pending changeset in place when --amend names it, adding no second file', () => {
    const first = runScript(root, SCRIPT, {
      args: ['--pkg', '@fix/cityville:minor', '--summary', 'Add road planning.'],
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
      args: ['--pkg', '@fix/cityville:minor', '--summary', 'Add road planning.'],
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
    const [file] = newChangesets(root, before);
    expect(readFileSync(join(root, '.changeset', file), 'utf8')).toMatch(
      /['"]@fix\/studio['"]: patch[\s\S]*Summary via stdin\./,
    );
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
