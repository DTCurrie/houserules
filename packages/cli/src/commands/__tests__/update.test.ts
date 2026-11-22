import { beforeEach, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { useInstalledRepo, useRepo } from '#test/repo';
import { runCli, runIn, type RunResult } from '#test/run';
import { readJson } from '#test/installed-tree';
import { PRETTIERIGNORE_REGION } from '../../modules/prettier-guard.js';
import { COMMITTED_SCRIPTS } from './update-test-support.js';

describe('update without --force on a committed houserules script with a local edit', () => {
  let root: string;
  let guardPath: string;
  let edited: string;
  let result: RunResult;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo', COMMITTED_SCRIPTS);
    guardPath = join(root, '.claude/scripts/guard-bash.mjs');
    appendFileSync(guardPath, '// my local tweak\n');
    edited = readFileSync(guardPath, 'utf8');
    result = runCli(['update', root]);
  });

  it('exits 0', () => {
    expect(result.status, result.stderr).toBe(0);
  });

  it('keeps the local edit instead of overwriting it', () => {
    expect(readFileSync(guardPath, 'utf8')).toBe(edited);
  });
});

describe('update without --force on a self-gitignored houserules script with a local edit', () => {
  let root: string;
  let guardPath: string;
  let installed: string;
  let result: RunResult;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    guardPath = join(root, '.claude/scripts/guard-bash.mjs');
    installed = readFileSync(guardPath, 'utf8');
    appendFileSync(guardPath, '// my local tweak\n');
    result = runCli(['update', root]);
  });

  it('exits 0', () => {
    expect(result.status, result.stderr).toBe(0);
  });

  it('overwrites it with the canonical script, since git never carries build output', () => {
    expect(readFileSync(guardPath, 'utf8')).toBe(installed);
  });
});

describe('update reporting the local edits it kept, in a repo that commits its scripts', () => {
  let root: string;

  const unwrapped = (text: string): string => text.replace(/\s+/g, ' ');

  function editKitScripts(count: number): void {
    for (const name of [
      'guard-bash.mjs',
      'session-context.mjs',
      'lint-format-fix.mjs',
      'rename.mjs',
    ].slice(0, count)) {
      appendFileSync(join(root, '.claude/scripts', name), '// tweak\n');
    }
  }

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo', COMMITTED_SCRIPTS);
  });

  it('points at the diff doctor already computes, so --force is not the only lever', () => {
    editKitScripts(1);

    const result = runCli(['update', root]);

    expect(unwrapped(result.stdout)).toContain(
      'See what changed: npx houserules doctor --json',
    );
  });

  it('blames a formatter when several houserules files read as edited, with the update remedy', () => {
    editKitScripts(3);

    const result = runCli(['update', root]);

    expect(unwrapped(result.stdout)).toContain(
      'A repo-wide formatter run is the likely cause. Run `npx houserules update --force` to restore them',
    );
  });

  it('stays silent about a formatter once a .prettierignore block protects the install', () => {
    editKitScripts(3);
    writeFileSync(
      join(root, '.prettierignore'),
      `${PRETTIERIGNORE_REGION.start}\n.claude/scripts/\n${PRETTIERIGNORE_REGION.end}\n`,
    );

    const result = runCli(['update', root]);

    expect(unwrapped(result.stdout)).not.toContain('likely cause');
  });

  it('says nothing about local edits when the install is clean', () => {
    const result = runCli(['update', root]);

    expect(unwrapped(result.stdout)).not.toContain('See what changed');
  });
});

describe('update --force on a committed houserules script with a local edit', () => {
  let root: string;
  let guardPath: string;
  let result: RunResult;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo', COMMITTED_SCRIPTS);
    guardPath = join(root, '.claude/scripts/guard-bash.mjs');
    appendFileSync(guardPath, '// my local tweak\n');
    result = runCli(['update', '--force', root]);
  });

  it('exits 0', () => {
    expect(result.status, result.stderr).toBe(0);
  });

  it('restores houserules version, discarding the local edit', () => {
    expect(readFileSync(guardPath, 'utf8')).not.toContain('my local tweak');
  });
});

describe('update on a kit-owned file that is stale relative to the shipped houserules content', () => {
  let root: string;
  let lintPath: string;
  let result: RunResult;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    lintPath = join(root, '.claude/scripts/lint-format-fix.mjs');
    writeFileSync(lintPath, '// OLD KIT VERSION\n');
    const manifestPath = join(root, '.claude/houserules.manifest.json');
    const manifest = readJson(manifestPath) as {
      files: Record<string, string>;
    };
    manifest.files['.claude/scripts/lint-format-fix.mjs'] = createHash('sha256')
      .update('// OLD KIT VERSION\n')
      .digest('hex');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    result = runCli(['update', root]);
  });

  it('exits 0', () => {
    expect(result.status, result.stderr).toBe(0);
  });

  it('replaces the stale content with the current houserules version, since the file was unedited by the user', () => {
    const refreshed = readFileSync(lintPath, 'utf8');
    expect(refreshed).not.toContain('OLD KIT VERSION');
    expect(refreshed).toContain('loadConfigSafe');
  });
});

describe('update --dry-run on reference templates committed before they were gitignored', () => {
  let root: string;
  const reviewerTpl = '.claude/templates/agents/reviewer.agent.md.template';
  let result: RunResult;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    runIn(root, 'git', ['add', '-f', '.claude/templates']);
    runIn(root, 'git', ['commit', '-qm', 'committed templates']);
    result = runCli(['update', '--dry-run', root]);
  });

  it('exits 0', () => {
    expect(result.status, result.stderr).toBe(0);
  });

  it('leaves the template tracked in git', () => {
    expect(runIn(root, 'git', ['ls-files', reviewerTpl]).trim()).toBe(
      reviewerTpl,
    );
  });
});

describe('update on reference templates committed before they were gitignored', () => {
  let root: string;
  const reviewerTpl = '.claude/templates/agents/reviewer.agent.md.template';
  let result: RunResult;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    runIn(root, 'git', ['add', '-f', '.claude/templates']);
    runIn(root, 'git', ['commit', '-qm', 'committed templates']);
    result = runCli(['update', root]);
  });

  it('exits 0', () => {
    expect(result.status, result.stderr).toBe(0);
  });

  it('untracks the template from git', () => {
    expect(runIn(root, 'git', ['ls-files', reviewerTpl]).trim()).toBe('');
  });

  it('leaves the working-tree template file on disk', () => {
    expect(
      existsSync(join(root, reviewerTpl)),
      'template file left on disk',
    ).toBe(true);
  });

  it('keeps templates/.gitignore tracked', () => {
    expect(
      runIn(root, 'git', ['ls-files', '.claude/templates/.gitignore']).trim(),
    ).toBe('.claude/templates/.gitignore');
  });
});

describe('update on a config the schema rejects', () => {
  it('reports the problem, exits 2, and writes nothing', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    const manifestPath = join(root, '.claude/houserules.manifest.json');
    writeFileSync(
      join(root, '.claude/houserules.config.json'),
      JSON.stringify({ targets: 'not-an-array' }),
    );
    const before = readFileSync(manifestPath, 'utf8');

    const result = runCli(['update', root]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'houserules.config.json: targets Invalid input: expected array, received string',
    );
    expect(readFileSync(manifestPath, 'utf8')).toBe(before);
  });
});

describe('init on a fresh pnpm monorepo', () => {
  it('gitignores .claude/scripts so compiled scripts are never committed', () => {
    const root = useRepo('pnpm-monorepo');
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    expect(
      existsSync(join(root, '.claude/scripts/.gitignore')),
      '.gitignore created',
    ).toBe(true);
    expect(
      runIn(root, 'git', ['ls-files', '.claude/scripts/guard-bash.mjs']).trim(),
    ).toBe('');
  });
});

describe('update on houserules scripts committed before they were gitignored', () => {
  let root: string;
  const guardScript = '.claude/scripts/guard-bash.mjs';
  let result: RunResult;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    runIn(root, 'git', ['add', '-f', '.claude/scripts']);
    runIn(root, 'git', ['commit', '-qm', 'committed scripts']);
    result = runCli(['update', root]);
  });

  it('exits 0', () => {
    expect(result.status, result.stderr).toBe(0);
  });

  it('untracks the script from git', () => {
    expect(runIn(root, 'git', ['ls-files', guardScript]).trim()).toBe('');
  });

  it('leaves the working-tree script file on disk', () => {
    expect(existsSync(join(root, guardScript)), 'script left on disk').toBe(
      true,
    );
  });

  it('keeps .claude/scripts/.gitignore tracked', () => {
    expect(
      runIn(root, 'git', ['ls-files', '.claude/scripts/.gitignore']).trim(),
    ).toBe('.claude/scripts/.gitignore');
  });

  it('stages the untrack without committing it', () => {
    expect(runIn(root, 'git', ['status', '--porcelain']).trim()).not.toBe('');
  });
});

describe('update with scripts.commit: true (opted in to committing scripts)', () => {
  let root: string;
  const guardScript = '.claude/scripts/guard-bash.mjs';
  let result: RunResult;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    const configPath = join(root, '.claude/houserules.config.json');
    const config = readJson<{ scripts?: { commit: boolean } }>(configPath);
    config.scripts = { commit: true };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    rmSync(join(root, '.claude/scripts/.gitignore'), { force: true });
    runIn(root, 'git', ['add', '-A']);
    runIn(root, 'git', ['commit', '-qm', 'opt-in commit + config change']);
    result = runCli(['update', root]);
  });

  it('exits 0', () => {
    expect(result.status, result.stderr).toBe(0);
  });

  it('does not recreate .claude/scripts/.gitignore', () => {
    expect(
      existsSync(join(root, '.claude/scripts/.gitignore')),
      '.gitignore not recreated',
    ).toBe(false);
  });

  it('leaves the already-tracked scripts tracked rather than untracking them', () => {
    expect(runIn(root, 'git', ['ls-files', guardScript]).trim()).toBe(
      guardScript,
    );
  });
});
