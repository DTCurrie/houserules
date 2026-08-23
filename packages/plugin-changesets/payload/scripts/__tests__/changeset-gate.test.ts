import { describe, expect, it } from 'vitest';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { runIn, runScript } from '#test/run';
import {
  checkPackageDrift,
  checkTranscriptOrdering,
  parseDeclaredPackages,
  parseTranscript,
} from '../changeset-gate.mjs';

const SCRIPT = '.claude/scripts/changeset-gate.mjs';
const PLUGIN_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function installChangesets(): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'cs/changesets',
    plugins: [{ name: PLUGIN_ROOT, alias: 'cs' }],
  });
}

function rewritePackageJson(
  root: string,
  dir: string,
  mutate: (pkg: Record<string, unknown>) => void,
): void {
  const path = join(root, dir, 'package.json');
  const pkg = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  mutate(pkg);
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

describe('parseDeclaredPackages', () => {
  it('reads the names between the frontmatter fences', () => {
    expect(
      parseDeclaredPackages('---\n"@fix/cityville": patch\n---\n\nMore.\n'),
    ).toEqual(['@fix/cityville']);
  });

  it('returns nothing for a body with no frontmatter fence', () => {
    expect(parseDeclaredPackages('More.\n')).toEqual([]);
  });
});

describe('checkPackageDrift', () => {
  it('flags a package the diff touches that the pending changeset does not declare', () => {
    const report = checkPackageDrift(
      [{ id: 'kit-abc123', declaredPkgs: ['@fix/cityville'] }],
      ['@fix/cityville', '@fix/studio'],
    );

    expect(report.findings).toEqual([
      {
        rule: 'changeset-gate/h5-package-drift',
        level: 'error',
        file: '.changeset/kit-abc123.md',
        line: null,
        msg: 'No pending changeset declares @fix/studio, which the current diff touches. Amend the changeset covering this feature, or add one.',
      },
    ]);
  });

  it('reports nothing when a sibling changeset declares the package', () => {
    const report = checkPackageDrift(
      [
        { id: 'kit-abc123', declaredPkgs: ['@fix/cityville'] },
        { id: 'kit-def456', declaredPkgs: ['@fix/studio'] },
      ],
      ['@fix/cityville', '@fix/studio'],
    );

    expect(report.findings).toEqual([]);
  });

  it('reports nothing when every touched package is declared', () => {
    const report = checkPackageDrift(
      [{ id: 'kit-abc123', declaredPkgs: ['@fix/cityville', '@fix/studio'] }],
      ['@fix/cityville', '@fix/studio'],
    );

    expect(report.findings).toEqual([]);
  });
});

function textEntry(text: string) {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } };
}

function userEntry() {
  return { type: 'user', message: { content: [{ type: 'text', text: 'ok' }] } };
}

function absorbCallEntry(
  command = 'node .claude/scripts/changeset-write.mjs --amend kit-a --absorb kit-b --summary "x"',
) {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', input: { command } }] },
  };
}

function majorCallEntry(
  command = 'node .claude/scripts/changeset-write.mjs --pkg @fix/cityville:major --summary "x"',
) {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', input: { command } }] },
  };
}

describe('checkTranscriptOrdering', () => {
  it('flags an --absorb call with no proposal text anywhere before it', () => {
    const report = checkTranscriptOrdering([absorbCallEntry()]);

    expect(report.findings).toEqual([
      {
        rule: 'changeset-gate/h9-absorb-order',
        level: 'error',
        file: 'transcript',
        line: null,
        msg: 'changeset-write --absorb ran with no proposal followed by a user turn before the call.',
      },
    ]);
  });

  it('flags an --absorb call made in the same turn as the proposal, with no user turn between them', () => {
    const report = checkTranscriptOrdering([
      textEntry('Proposing to absorb kit-b into kit-a.'),
      absorbCallEntry(),
    ]);

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.rule).toBe('changeset-gate/h9-absorb-order');
  });

  it('passes an --absorb call preceded by a proposal and a user turn', () => {
    const report = checkTranscriptOrdering([
      textEntry('Proposing to absorb kit-b into kit-a.'),
      userEntry(),
      absorbCallEntry(),
    ]);

    expect(report.findings).toEqual([]);
  });

  it('flags a major-bump write with no proposal and confirmation before it', () => {
    const report = checkTranscriptOrdering([majorCallEntry()]);

    expect(report.findings).toEqual([
      {
        rule: 'changeset-gate/h6-major-confirm',
        level: 'error',
        file: 'transcript',
        line: null,
        msg: 'changeset-write ran a major bump with no proposal followed by a user turn before the call.',
      },
    ]);
  });

  it('passes a major-bump write preceded by a proposal and a user turn', () => {
    const report = checkTranscriptOrdering([
      textEntry('This looks like a breaking change, recording it as major.'),
      userEntry(),
      majorCallEntry(),
    ]);

    expect(report.findings).toEqual([]);
  });

  it('does not flag a patch-level write', () => {
    const report = checkTranscriptOrdering([
      majorCallEntry(
        'node .claude/scripts/changeset-write.mjs --pkg @fix/cityville:patch --summary "x"',
      ),
    ]);

    expect(report.findings).toEqual([]);
  });
});

describe('parseTranscript', () => {
  it('parses one JSON object per line and skips a malformed line', () => {
    const raw = `${JSON.stringify({ type: 'user' })}\nnot json\n${JSON.stringify({ type: 'assistant' })}\n`;

    expect(parseTranscript(raw)).toEqual([
      { type: 'user' },
      { type: 'assistant' },
    ]);
  });
});

describe('changeset-gate.mjs', () => {
  it('exits 0 when nothing pending is new and no transcript is given', () => {
    const root = installChangesets();
    const r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status, r.stderr).toBe(0);
  });

  it('exits 2 naming the extra package when a freshly written changeset omits a touched package', () => {
    const root = installChangesets();
    appendFileSync(
      join(root, 'apps/studio/src/main.ts'),
      'export const two = 2;\n',
    );
    writeFileSync(
      join(root, '.changeset/kit-drift.md'),
      '---\n"@fix/cityville": patch\n---\n\nMore.\n',
    );

    const r = runScript(root, SCRIPT, { input: '{}' });

    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/h5-package-drift/);
    expect(r.stderr).toMatch(/@fix\/studio/);
  });

  it('stays silent when the freshly written changeset declares every touched package', () => {
    const root = installChangesets();
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const more = 2;\n',
    );
    writeFileSync(
      join(root, '.changeset/kit-ok.md'),
      '---\n"@fix/cityville": patch\n---\n\nMore.\n',
    );

    const r = runScript(root, SCRIPT, { input: '{}' });

    expect(r.status, r.stderr).toBe(0);
  });

  it('ignores an already-committed changeset even when a later change touches a different package', () => {
    const root = installChangesets();
    writeFileSync(
      join(root, '.changeset/kit-settled.md'),
      '---\n"@fix/cityville": patch\n---\n\nMore.\n',
    );
    runIn(root, 'git', ['add', '-A']);
    runIn(root, 'git', ['commit', '-qm', 'feat: cityville, with changeset']);
    appendFileSync(
      join(root, 'apps/studio/src/main.ts'),
      'export const two = 2;\n',
    );

    const r = runScript(root, SCRIPT, { input: '{}' });

    expect(r.status, r.stderr).toBe(0);
  });

  it('ignores a package whose only dirty diff is its package.json wireit block', () => {
    const root = installChangesets();
    rewritePackageJson(root, 'games/cityville', (pkg) => {
      pkg.wireit = { build: { files: ['src/**', '!**/__tests__/**'] } };
    });
    appendFileSync(
      join(root, 'apps/studio/src/main.ts'),
      'export const two = 2;\n',
    );
    writeFileSync(
      join(root, '.changeset/kit-wireit.md'),
      '---\n"@fix/studio": patch\n---\n\nMore.\n',
    );

    const r = runScript(root, SCRIPT, { input: '{}' });

    expect(r.status, r.stderr).toBe(0);
  });

  it('ignores a wireit-only package.json edit committed on a branch', () => {
    const root = installChangesets();
    runIn(root, 'git', ['checkout', '-qb', 'feature']);
    rewritePackageJson(root, 'games/cityville', (pkg) => {
      pkg.wireit = { build: { files: ['src/**'] } };
    });
    runIn(root, 'git', ['add', '-A']);
    runIn(root, 'git', ['commit', '-qm', 'chore: wireit globs']);
    appendFileSync(
      join(root, 'apps/studio/src/main.ts'),
      'export const two = 2;\n',
    );
    writeFileSync(
      join(root, '.changeset/kit-wireit.md'),
      '---\n"@fix/studio": patch\n---\n\nMore.\n',
    );

    const r = runScript(root, SCRIPT, { input: '{}' });

    expect(r.status, r.stderr).toBe(0);
  });

  it('still counts a package.json edit that reaches past the wireit block', () => {
    const root = installChangesets();
    rewritePackageJson(root, 'games/cityville', (pkg) => {
      pkg.wireit = { build: { files: ['src/**'] } };
      pkg.version = '0.2.0';
    });
    writeFileSync(
      join(root, '.changeset/kit-real.md'),
      '---\n"@fix/studio": patch\n---\n\nMore.\n',
    );

    const r = runScript(root, SCRIPT, { input: '{}' });

    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/@fix\/cityville/);
  });

  it('ignores a package-root CLAUDE.md the files list does not ship', () => {
    const root = installChangesets();
    rewritePackageJson(root, 'games/cityville', (pkg) => {
      pkg.files = ['src'];
    });
    runIn(root, 'git', ['add', '-A']);
    runIn(root, 'git', ['commit', '-qm', 'chore: files list']);
    writeFileSync(
      join(root, 'games/cityville/CLAUDE.md'),
      '# cityville\n\nRepo docs.\n',
    );
    appendFileSync(
      join(root, 'apps/studio/src/main.ts'),
      'export const two = 2;\n',
    );
    writeFileSync(
      join(root, '.changeset/kit-docs.md'),
      '---\n"@fix/studio": patch\n---\n\nMore.\n',
    );

    const r = runScript(root, SCRIPT, { input: '{}' });

    expect(r.status, r.stderr).toBe(0);
  });

  it('still counts a package-root doc the files list names', () => {
    const root = installChangesets();
    rewritePackageJson(root, 'games/cityville', (pkg) => {
      pkg.files = ['src', 'CONVENTIONS.md'];
    });
    runIn(root, 'git', ['add', '-A']);
    runIn(root, 'git', ['commit', '-qm', 'chore: files list']);
    writeFileSync(
      join(root, 'games/cityville/CONVENTIONS.md'),
      '# Conventions\n',
    );
    writeFileSync(
      join(root, '.changeset/kit-conventions.md'),
      '---\n"@fix/studio": patch\n---\n\nMore.\n',
    );

    const r = runScript(root, SCRIPT, { input: '{}' });

    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/@fix\/cityville/);
  });

  it('still counts a README.md edit the files list omits, since npm packs it regardless', () => {
    const root = installChangesets();
    rewritePackageJson(root, 'games/cityville', (pkg) => {
      pkg.files = ['src'];
    });
    runIn(root, 'git', ['add', '-A']);
    runIn(root, 'git', ['commit', '-qm', 'chore: files list']);
    writeFileSync(join(root, 'games/cityville/README.md'), '# cityville\n');
    writeFileSync(
      join(root, '.changeset/kit-readme.md'),
      '---\n"@fix/studio": patch\n---\n\nMore.\n',
    );

    const r = runScript(root, SCRIPT, { input: '{}' });

    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/@fix\/cityville/);
  });

  it('counts a package-root CLAUDE.md when package.json has no files list', () => {
    const root = installChangesets();
    writeFileSync(
      join(root, 'games/cityville/CLAUDE.md'),
      '# cityville\n\nRepo docs.\n',
    );
    writeFileSync(
      join(root, '.changeset/kit-nofiles.md'),
      '---\n"@fix/studio": patch\n---\n\nMore.\n',
    );

    const r = runScript(root, SCRIPT, { input: '{}' });

    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/@fix\/cityville/);
  });

  it('ignores a tsconfig-only diff', () => {
    const root = installChangesets();
    writeFileSync(
      join(root, 'games/cityville/tsconfig.build.json'),
      '{"exclude":["src/**/__tests__/**"]}\n',
    );
    appendFileSync(
      join(root, 'apps/studio/src/main.ts'),
      'export const two = 2;\n',
    );
    writeFileSync(
      join(root, '.changeset/kit-tsconfig.md'),
      '---\n"@fix/studio": patch\n---\n\nMore.\n',
    );

    const r = runScript(root, SCRIPT, { input: '{}' });

    expect(r.status, r.stderr).toBe(0);
  });

  it('exits 0 when stop_hook_active is set', () => {
    const root = installChangesets();
    appendFileSync(
      join(root, 'apps/studio/src/main.ts'),
      'export const two = 2;\n',
    );
    writeFileSync(
      join(root, '.changeset/kit-drift.md'),
      '---\n"@fix/cityville": patch\n---\n\nMore.\n',
    );

    const r = runScript(root, SCRIPT, {
      input: '{"stop_hook_active":true}',
    });

    expect(r.status).toBe(0);
  });

  it('exits 2 for an unconfirmed absorb call found in the given transcript', () => {
    const root = installChangesets();
    const transcriptPath = join(root, 'transcript.jsonl');
    writeFileSync(transcriptPath, `${JSON.stringify(absorbCallEntry())}\n`);

    const r = runScript(root, SCRIPT, {
      input: JSON.stringify({ transcript_path: transcriptPath }),
    });

    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/h9-absorb-order/);
  });

  it('stays silent for a confirmed absorb call found in the given transcript', () => {
    const root = installChangesets();
    const transcriptPath = join(root, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify(textEntry('Proposing to absorb kit-b into kit-a.')),
        JSON.stringify(userEntry()),
        JSON.stringify(absorbCallEntry()),
      ].join('\n') + '\n',
    );

    const r = runScript(root, SCRIPT, {
      input: JSON.stringify({ transcript_path: transcriptPath }),
    });

    expect(r.status, r.stderr).toBe(0);
  });
});
