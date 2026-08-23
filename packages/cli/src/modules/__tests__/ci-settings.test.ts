import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { useInstalledRepo } from '#test/repo';
import { manifestOf, settingsOf, sha256 } from '#test/installed-tree';

const CI_SETTINGS = '.claude/settings.ci.json';

function denyListOf(root: string): string[] {
  const parsed = JSON.parse(readFileSync(join(root, CI_SETTINGS), 'utf8'));
  return parsed.permissions.deny;
}

describe('ci-settings', () => {
  it('denies edits to the paths a human owns', () => {
    const root = useInstalledRepo('pnpm-monorepo', { modules: 'ci-settings' });

    const deny = denyListOf(root);
    expect(deny).toContain('Edit(file_path=.github/**)');
    expect(deny).toContain('Write(file_path=.github/**)');
    expect(deny).toContain('Edit(file_path=dist/**)');
    expect(deny).toContain('Edit(file_path=.changeset/**)');
  });

  it('names the lockfile of the detected package manager', () => {
    const root = useInstalledRepo('pnpm-monorepo', { modules: 'ci-settings' });

    expect(denyListOf(root)).toContain('Edit(file_path=pnpm-lock.yaml)');
  });

  it('is tracked as kit-owned so update can refresh it', () => {
    const root = useInstalledRepo('pnpm-monorepo', { modules: 'ci-settings' });

    expect(manifestOf(root).files[CI_SETTINGS]).toBe(
      sha256(readFileSync(join(root, CI_SETTINGS), 'utf8')),
    );
  });

  it('leaves settings.json alone, since these denials would break interactive work', () => {
    const root = useInstalledRepo('pnpm-monorepo', { modules: 'ci-settings' });

    const deny = settingsOf(root).permissions?.deny ?? [];
    expect(
      deny,
      'denying .changeset/** in settings.json would break the /changeset skill',
    ).toEqual([]);
  });

  it('is not installed by default', () => {
    const root = useInstalledRepo('pnpm-monorepo');

    expect(manifestOf(root).modules.includes('ci-settings')).toBe(false);
    expect(existsSync(join(root, CI_SETTINGS))).toBe(false);
  });
});
