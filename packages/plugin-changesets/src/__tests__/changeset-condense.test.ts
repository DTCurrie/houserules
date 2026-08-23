import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { manifestOf, settingsOf, sha256 } from '#test/installed-tree';

const PLUGIN_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_ROOT, alias: 'cs' }];

const SKILL_PATH = '.claude/skills/changeset-condense/SKILL.md';

function installed(): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'cs/changesets',
    plugins: PLUGINS,
  });
}

function frontmatter(text: string): string {
  return text.split('---')[1] ?? '';
}

describe('changeset-condense', () => {
  it('installs the skill and tracks it under the changesets module', () => {
    const root = installed();

    expect(existsSync(join(root, SKILL_PATH))).toBe(true);

    const manifest = manifestOf(root);
    expect(manifest.modules.includes('cs/changesets')).toBe(true);
    expect(manifest.files[SKILL_PATH]).toBe(
      sha256(readFileSync(join(root, SKILL_PATH))),
    );
  });

  it('carries the routing terms a request to condense changesets would use', () => {
    const root = installed();

    const description = frontmatter(
      readFileSync(join(root, SKILL_PATH), 'utf8'),
    );
    expect(description).toMatch(/condens/i);
    expect(description).toMatch(/consolidat/i);
    expect(description).toMatch(/changeset/i);
  });

  it('names the flag-rename case as one entry superseding another', () => {
    const root = installed();

    const body = readFileSync(join(root, SKILL_PATH), 'utf8');
    expect(body).toMatch(/Renames `x` to `y`/);
  });

  it('states that everything pending ships in the same release', () => {
    const root = installed();

    const body = readFileSync(join(root, SKILL_PATH), 'utf8');
    expect(body).toMatch(
      /Everything in `\.changeset\/` ships in the same release/,
    );
  });

  it('executes an absorb through changeset-write.mjs rather than hand-editing files', () => {
    const root = installed();

    const body = readFileSync(join(root, SKILL_PATH), 'utf8');
    expect(body).toMatch(
      /node \.claude\/scripts\/changeset-write\.mjs --amend/,
    );
    expect(body).toMatch(/--absorb/);
    expect(body).toMatch(/Never hand-edit a `\.changeset\/\*\.md`/);
  });

  it('adds nothing to the always-loaded surface', () => {
    const root = installed();

    const settings = settingsOf(root);
    const commands = Object.values(settings.hooks ?? {}).flatMap(
      (groups: any) =>
        groups.flatMap((group: any) =>
          group.hooks.map((hook: any) => hook.command),
        ),
    );
    expect(commands.some((c: string) => c.includes('changeset-condense'))).toBe(
      false,
    );
    expect(
      readFileSync(join(root, 'CLAUDE.md'), 'utf8').includes(
        'changeset-condense',
      ),
    ).toBe(false);
    expect(existsSync(join(root, '.claude/rules/changeset-condense.md'))).toBe(
      false,
    );
  });
});
