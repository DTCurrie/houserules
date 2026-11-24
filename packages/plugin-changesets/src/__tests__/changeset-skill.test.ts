import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { allHookCommands, manifestOf, sha256 } from '#test/installed-tree';

const PLUGIN_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_ROOT, alias: 'cs' }];

const SKILL_PATH = '.claude/skills/changeset/SKILL.md';
const RETIRED_SKILL_PATH = '.claude/skills/changeset-condense/SKILL.md';

function installed(): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'cs/changesets',
    plugins: PLUGINS,
  });
}

function frontmatter(text: string): string {
  return text.split('---')[1] ?? '';
}

describe('changeset skill condense section', () => {
  it('installs the skill and tracks it under the changesets module', () => {
    const root = installed();

    expect(existsSync(join(root, SKILL_PATH)), `${SKILL_PATH} exists`).toBe(
      true,
    );

    const manifest = manifestOf(root);
    expect(manifest.modules).toContain('cs/changesets');
    expect(manifest.files[SKILL_PATH]).toBe(
      sha256(readFileSync(join(root, SKILL_PATH))),
    );
  });

  it('does not install a separate changeset-condense skill', () => {
    const root = installed();

    expect(
      existsSync(join(root, '.claude/skills/changeset-condense')),
      'changeset-condense skill directory absent',
    ).toBe(false);
    expect(manifestOf(root).files[RETIRED_SKILL_PATH]).toBeUndefined();
  });

  it('carries the routing terms a request to condense changesets would use', () => {
    const root = installed();

    const description = frontmatter(
      readFileSync(join(root, SKILL_PATH), 'utf8'),
    );
    expect(description).toMatch(/condens/i);
    expect(description).toMatch(/consolidat/i);
    expect(description).toMatch(/supersedes, extends, or fixes an earlier one/);
    expect(description).toMatch(/Record a pending release note/);
  });

  it('has a Condense section that points step 1 at it instead of a separate skill', () => {
    const root = installed();

    const body = readFileSync(join(root, SKILL_PATH), 'utf8');
    expect(body).toMatch(/^## Condense$/m);
    expect(body).toMatch(/\/changeset condense \[id \.\.\.\]/);
    expect(body).not.toContain('/changeset-condense');
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
      /node \.claude\/scripts\/changeset-write\.mjs --amend <survivor> --absorb/,
    );
    expect(body).toMatch(/Never hand-edit a `\.changeset\/\*\.md`/);
  });

  it('adds nothing to the always-loaded surface', () => {
    const root = installed();

    const commands = allHookCommands(root);
    expect(
      commands.some((c: string) => c.includes('changeset-condense')),
      `hook commands ${JSON.stringify(commands)} exclude changeset-condense`,
    ).toBe(false);
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).not.toContain(
      'changeset-condense',
    );
    const rulePath = join(root, '.claude/rules/changeset-condense.md');
    expect(existsSync(rulePath), `${rulePath} absent`).toBe(false);
  });
});
