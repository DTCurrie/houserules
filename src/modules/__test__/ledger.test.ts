import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { useInstalledRepo } from '#test/repo';
import { runIn, runScript } from '#test/run';
import { kitConfigPath, readJson } from '#test/installed-tree';

describe('ledger', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo', {
      modules: 'ledger',
    });
  });

  it('installs the ledger script', () => {
    expect(
      existsSync(join(root, '.claude/scripts/package-changelog.mjs')),
    ).toBeTruthy();
  });

  it('ships the archivist agent template the ledger module references', () => {
    expect(
      existsSync(
        join(root, '.claude/kit-templates/agents/archivist.agent.md.template'),
      ),
    ).toBeTruthy();
  });

  it('retargets each target’s changelog to .claude/changelogs/ instead of CHANGELOG.md', () => {
    const config = readJson(kitConfigPath(root));
    expect(config.ledger.enabled).toBe(true);
    const cityville = config.targets.find((t: any) => t.name === 'cityville');
    expect(cityville.changelogPath).toBe('.claude/changelogs/cityville.md');
    expect(cityville.logPath).toBe('.claude/changelogs/cityville.log');
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
    expect(
      existsSync(join(root, '.claude/changelogs/cityville.md')),
    ).toBeTruthy();
    expect(
      existsSync(join(root, '.claude/changelogs/cityville.log')),
    ).toBeTruthy();
  });
});
