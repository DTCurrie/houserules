import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { useInstalledRepo } from '#test/repo';
import { runCli } from '#test/run';
import { readJson } from '#test/installed-tree';
import type { InstalledHouseConfig } from '#test/installed-tree';

const SCRIPT = '.claude/scripts/verify-changed.mjs';

describe('verify-changed install', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo', { modules: 'verify-changed' });
  });

  it('installs the helper script and skill', () => {
    expect(existsSync(join(root, SCRIPT)), 'helper script installed').toBe(
      true,
    );
    expect(
      existsSync(join(root, '.claude/skills/verify-changed/SKILL.md')),
      'skill installed',
    ).toBe(true);
  });

  it('seeds a verify block with the detected commands', () => {
    const config = readJson<InstalledHouseConfig>(
      join(root, '.claude/houserules.config.json'),
    );
    expect(config.verify, 'verify block present').toBeTruthy();
    expect(config.verify!.commands).toEqual(['verify']);
  });

  it('records the module in the manifest', () => {
    const manifest = readJson<{ modules: string[] }>(
      join(root, '.claude/houserules.manifest.json'),
    );
    expect(manifest.modules.includes('verify-changed')).toBe(true);
  });

  it('wires the script permission into settings.json', () => {
    const settings = readJson<{ permissions: { allow: string[] } }>(
      join(root, '.claude/settings.json'),
    );
    expect(
      settings.permissions.allow.some((p) => p.includes('verify-changed.mjs')),
      'script permission wired',
    ).toBe(true);
  });

  it('leaves doctor at exit 0', () => {
    expect(runCli(['doctor', root]).status).toBe(0);
  });
});

describe('verify-changed absent', () => {
  it('leaves the verify block out of houserules.config.json by default', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    const config = readJson<InstalledHouseConfig>(
      join(root, '.claude/houserules.config.json'),
    );
    expect(config.verify, 'no verify block by default').toBe(undefined);
  });
});
