import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useRepo } from '#test/repo';
import { runIn } from '#test/run';

const SCRIPT = fileURLToPath(
  new URL('../../../payload-dist/scripts/review-package.mjs', import.meta.url),
);

function run(cwd: string, args: string[]) {
  const env = { ...process.env };
  delete env.NODE_PATH;
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env,
  });
}

function repoWithTwoFeatureCommits(): {
  root: string;
  baseTag: string;
  headBranch: string;
} {
  const root = useRepo('non-js');
  runIn(root, 'git', ['tag', 'before-features']);

  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/feature-one.ts'), 'export const one = 1;\n');
  runIn(root, 'git', ['add', '-A']);
  runIn(root, 'git', ['commit', '-qm', 'add feature one']);

  runIn(root, 'git', ['checkout', '-qb', 'topic/features']);
  writeFileSync(join(root, 'src/feature-two.ts'), 'export const two = 2;\n');
  runIn(root, 'git', ['add', '-A']);
  runIn(root, 'git', ['commit', '-qm', 'add feature two']);

  return { root, baseTag: 'before-features', headBranch: 'topic/features' };
}

describe('review-package.mjs <base>..<head>', () => {
  it('writes a file with commits, stat, and diff sections, printing only the path and a summary to stdout', () => {
    const { root, baseTag, headBranch } = repoWithTwoFeatureCommits();

    const r = run(root, [`${baseTag}..${headBranch}`]);

    expect(r.status, r.stderr).toBe(0);
    const [path, summary] = r.stdout.trim().split('\n');
    expect(existsSync(path as string), r.stdout).toBe(true);
    expect(summary).toBe('2 commit(s), 2 file(s) changed');
    expect(r.stdout).not.toContain('export const two = 2;');

    const content = readFileSync(path as string, 'utf8');
    expect(content).toContain(`# Review package: ${baseTag}..${headBranch}`);
    expect(content).toContain('## Commits');
    expect(content).toContain('add feature one');
    expect(content).toContain('add feature two');
    expect(content).toContain('## Stat');
    expect(content).toContain('feature-one.ts');
    expect(content).toContain('feature-two.ts');
    expect(content).toContain('## Diff');
    expect(content).toContain('export const two = 2;');
  });

  it('defaults the out path under .claude/plans/, replacing "/" in ref names with "-"', () => {
    const { root, baseTag, headBranch } = repoWithTwoFeatureCommits();

    const r = run(root, [`${baseTag}..${headBranch}`]);

    expect(r.status, r.stderr).toBe(0);
    const path = r.stdout.trim().split('\n')[0] as string;
    expect(path).toBe(
      join(
        realpathSync(root),
        `.claude/plans/review-package-${baseTag}-topic-features.md`,
      ),
    );
  });

  it('writes to the path given by --out instead of the default', () => {
    const { root, baseTag, headBranch } = repoWithTwoFeatureCommits();
    const outPath = join(root, 'custom', 'package.md');

    const r = run(root, [`${baseTag}..${headBranch}`, '--out', outPath]);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split('\n')[0]).toBe(outPath);
    expect(existsSync(outPath)).toBe(true);
  });

  it('exits 1 with a one-line stderr message outside a git directory', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'review-package-not-git-'));

    const r = run(cwd, ['main..HEAD']);

    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
    expect(r.stderr).toContain('not a git repository');
  });

  it('exits 1 on an unknown ref', () => {
    const { root, headBranch } = repoWithTwoFeatureCommits();

    const r = run(root, [`no-such-ref..${headBranch}`]);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown ref "no-such-ref"');
  });

  it('exits 1 on an empty range', () => {
    const { root, baseTag } = repoWithTwoFeatureCommits();

    const r = run(root, [`${baseTag}..${baseTag}`]);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no commits between');
  });
});

const PHASE_FILE = [
  '# Phase 5',
  '',
  '## Slices',
  '',
  '| id  | owns              | depends | wave | status |',
  '| --- | ----------------- | ------- | ---- | ------ |',
  '| 5a  | `payload/a.mts`   | —       | 1    | TODO   |',
  '| 5b  | `payload/b.mts`   | —       | 1    | TODO   |',
  '',
  '## Notes',
  '',
  'Not a slice table row.',
  '',
].join('\n');

function repoWithPhaseFile(): { root: string; phaseFile: string } {
  const root = useRepo('non-js');
  const phaseFile = join(root, 'phase-5.md');
  writeFileSync(phaseFile, PHASE_FILE);
  return { root, phaseFile };
}

describe('review-package.mjs --briefs <phase-file> [<slice-id>]', () => {
  it('prints the whole slice table with no slice id', () => {
    const { root, phaseFile } = repoWithPhaseFile();

    const r = run(root, ['--briefs', phaseFile]);

    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('| id');
    expect(lines.some((l) => l.includes('5a'))).toBe(true);
    expect(lines.some((l) => l.includes('5b'))).toBe(true);
  });

  it('prints only the header row and the matching slice row when given a slice id', () => {
    const { root, phaseFile } = repoWithPhaseFile();

    const r = run(root, ['--briefs', phaseFile, '5b']);

    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('5b');
    expect(lines[2]).not.toContain('5a');
  });

  it('exits 1 with a clear message when the phase file has no "## Slices" section', () => {
    const root = useRepo('non-js');
    const phaseFile = join(root, 'no-slices.md');
    writeFileSync(phaseFile, '# Phase 6\n\nNo slices here.\n');

    const r = run(root, ['--briefs', phaseFile]);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('## Slices');
  });

  it('exits 1 with a clear message when the slice id is absent from the table', () => {
    const { root, phaseFile } = repoWithPhaseFile();

    const r = run(root, ['--briefs', phaseFile, '9z']);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('slice "9z" not found');
  });

  it('exits 1 with a clear message when the phase file does not exist', () => {
    const root = useRepo('non-js');

    const r = run(root, ['--briefs', join(root, 'missing.md')]);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no such file');
  });
});
