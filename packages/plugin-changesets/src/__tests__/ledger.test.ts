import { beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { runIn, runScript } from '#test/run';
import { houseConfigPath, readJson } from '#test/installed-tree';

const PLUGIN_ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('ledger', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo', {
      modules: 'cs/ledger',
      plugins: [{ name: PLUGIN_ROOT, alias: 'cs' }],
    });
  });

  it('installs the ledger script', () => {
    expect(
      existsSync(join(root, '.claude/scripts/package-changelog.mjs')),
    ).toBe(true);
  });

  it('ships the archivist agent template the ledger module references', () => {
    expect(
      existsSync(
        join(root, '.claude/templates/agents/archivist.agent.md.template'),
      ),
    ).toBe(true);
  });

  it('retargets each target’s changelog to .claude/changelogs/ instead of CHANGELOG.md', () => {
    const config = readJson<{
      ledger: { enabled: boolean };
      targets: { name: string; changelogPath: string; logPath: string }[];
    }>(houseConfigPath(root));
    expect(config.ledger.enabled).toBe(true);
    const cityville = config.targets.find((t) => t.name === 'cityville');
    expect(cityville?.changelogPath).toBe('.claude/changelogs/cityville.md');
    expect(cityville?.logPath).toBe('.claude/changelogs/cityville.log');
  });

  it('records a change into the retargeted changelog for a target', () => {
    writeFileSync(
      join(root, 'games/cityville/src/extra.ts'),
      'export const extra = 1;\n',
    );
    runIn(root, 'git', ['add', '-A']);
    runIn(root, 'git', ['commit', '-qm', 'feat: cityville change']);
    const rec = runScript(root, '.claude/scripts/package-changelog.mjs', {
      args: ['record', 'cityville', 'HEAD', '--changes', '- did a thing'],
    });
    expect(rec.status, rec.stderr).toBe(0);
    expect(existsSync(join(root, '.claude/changelogs/cityville.md'))).toBe(
      true,
    );
    expect(existsSync(join(root, '.claude/changelogs/cityville.log'))).toBe(
      true,
    );
  });

  it('skips a commit that does not touch the target, exiting 0 with a diagnostic', () => {
    writeFileSync(
      join(root, 'apps/studio/src/extra.ts'),
      'export const extra = 1;\n',
    );
    runIn(root, 'git', ['add', '-A']);
    runIn(root, 'git', ['commit', '-qm', 'feat: studio change']);

    const rec = runScript(root, '.claude/scripts/package-changelog.mjs', {
      args: ['record', 'cityville', 'HEAD', '--changes', '- did a thing'],
    });

    expect(rec.status).toBe(0);
    expect(rec.stderr).toMatch(
      /does not touch games\/cityville\/src\/\. Nothing recorded\./,
    );
    expect(existsSync(join(root, '.claude/changelogs/cityville.md'))).toBe(
      false,
    );
  });

  it('skips a duplicate record for a commit already in the changelog', () => {
    writeFileSync(
      join(root, 'games/cityville/src/extra.ts'),
      'export const extra = 1;\n',
    );
    runIn(root, 'git', ['add', '-A']);
    runIn(root, 'git', ['commit', '-qm', 'feat: cityville change']);
    runScript(root, '.claude/scripts/package-changelog.mjs', {
      args: ['record', 'cityville', 'HEAD', '--changes', '- did a thing'],
    });

    const rec = runScript(root, '.claude/scripts/package-changelog.mjs', {
      args: ['record', 'cityville', 'HEAD', '--changes', '- did a thing'],
    });

    expect(rec.status).toBe(0);
    expect(rec.stderr).toMatch(/already in .*cityville\.md. Skipping\./);
  });

  it('exits 1 when --changes is missing', () => {
    writeFileSync(
      join(root, 'games/cityville/src/extra.ts'),
      'export const extra = 1;\n',
    );
    runIn(root, 'git', ['add', '-A']);
    runIn(root, 'git', ['commit', '-qm', 'feat: cityville change']);

    const rec = runScript(root, '.claude/scripts/package-changelog.mjs', {
      args: ['record', 'cityville', 'HEAD'],
    });

    expect(rec.status).toBe(1);
    expect(rec.stderr).toMatch(/Missing required --changes/);
    expect(existsSync(join(root, '.claude/changelogs/cityville.md'))).toBe(
      false,
    );
  });

  it('exits 1 with no matching entries when show finds no log file yet', () => {
    const r = runScript(root, '.claude/scripts/package-changelog.mjs', {
      args: ['show', 'cityville', 'abc1234'],
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/No cityville changelog log yet\./);
  });

  it('prints the matching recorded entry for show', () => {
    writeFileSync(
      join(root, 'games/cityville/src/extra.ts'),
      'export const extra = 1;\n',
    );
    runIn(root, 'git', ['add', '-A']);
    runIn(root, 'git', ['commit', '-qm', 'feat: cityville change']);
    const rec = runScript(root, '.claude/scripts/package-changelog.mjs', {
      args: ['record', 'cityville', 'HEAD', '--changes', '- did a thing'],
    });
    const sha = rec.stdout.trim();

    const r = runScript(root, '.claude/scripts/package-changelog.mjs', {
      args: ['show', 'cityville', sha],
    });

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/feat: cityville change/);
    expect(r.stdout).toMatch(/did a thing/);
  });

  it('exits 1 when show finds no entry matching the ref', () => {
    writeFileSync(
      join(root, 'games/cityville/src/extra.ts'),
      'export const extra = 1;\n',
    );
    runIn(root, 'git', ['add', '-A']);
    runIn(root, 'git', ['commit', '-qm', 'feat: cityville change']);
    runScript(root, '.claude/scripts/package-changelog.mjs', {
      args: ['record', 'cityville', 'HEAD', '--changes', '- did a thing'],
    });

    const r = runScript(root, '.claude/scripts/package-changelog.mjs', {
      args: ['show', 'cityville', 'deadbeef'],
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/No log entries for deadbeef\./);
  });

  it('lists every recorded entry for a target', () => {
    writeFileSync(
      join(root, 'games/cityville/src/extra.ts'),
      'export const extra = 1;\n',
    );
    runIn(root, 'git', ['add', '-A']);
    runIn(root, 'git', ['commit', '-qm', 'feat: cityville change']);
    runScript(root, '.claude/scripts/package-changelog.mjs', {
      args: ['record', 'cityville', 'HEAD', '--changes', '- did a thing'],
    });

    const r = runScript(root, '.claude/scripts/package-changelog.mjs', {
      args: ['list', 'cityville'],
    });

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/feat: cityville change/);
  });

  it('reports skipped lines on stderr when the log has a corrupted entry, without dropping the good ones from list', () => {
    writeFileSync(
      join(root, 'games/cityville/src/extra.ts'),
      'export const extra = 1;\n',
    );
    runIn(root, 'git', ['add', '-A']);
    runIn(root, 'git', ['commit', '-qm', 'feat: cityville change']);
    runScript(root, '.claude/scripts/package-changelog.mjs', {
      args: ['record', 'cityville', 'HEAD', '--changes', '- did a thing'],
    });
    appendFileSync(
      join(root, '.claude/changelogs/cityville.log'),
      'not valid json\n',
    );

    const r = runScript(root, '.claude/scripts/package-changelog.mjs', {
      args: ['list', 'cityville'],
    });

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/feat: cityville change/);
    expect(r.stderr).toMatch(/skipped 1 line\(s\)/);
  });
});
