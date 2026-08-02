import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { treeHash, useInstalledRepo, useRepo } from '#test/repo';
import { runCli, type RunResult } from '#test/run';
import {
  REGION_END,
  REGION_START,
  allHookCommands,
  claudeMdPath,
  hookCommandsFor,
  kitConfigPath,
  manifestOf,
  readClaudeMd,
  readJson,
  settingsOf,
} from '#test/installed-tree';

function seedUserSettings(root: string): void {
  writeFileSync(
    join(root, '.claude/settings.json'),
    `${JSON.stringify(
      {
        permissions: { allow: ['Bash(echo mine)'] },
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: 'node ./my-own-hook.js' }],
            },
          ],
          Stop: [
            {
              hooks: [{ type: 'command', command: 'node ./my-stop-hook.js' }],
            },
          ],
        },
        someUnrelatedKey: { keepMe: true },
      },
      null,
      2,
    )}\n`,
  );
}

describe('init --yes on a pnpm monorepo', () => {
  let root: string;
  let changesetHashBefore: string;
  let initResult: RunResult;

  beforeEach(() => {
    root = useRepo('pnpm-monorepo');
    changesetHashBefore = treeHash(join(root, '.changeset'));
    initResult = runCli(['init', '--yes', root]);
  });

  it('exits 0', () => {
    expect(initResult.status, initResult.stderr).toBe(0);
  });

  it('installs every kit-owned file', () => {
    for (const rel of [
      '.claude/scripts/guard-bash.mjs',
      '.claude/scripts/lint-format-fix.mjs',
      '.claude/scripts/backlog-log.mjs',
      '.claude/scripts/changeset-write.mjs',
      '.claude/scripts/changeset-check.mjs',
      '.claude/scripts/session-context.mjs',
      '.claude/scripts/rename.mjs',
      '.claude/scripts/lib/workspaces.mjs',
      '.claude/skills/backlog-add/SKILL.md',
      '.claude/skills/changeset/SKILL.md',
      '.claude/agents/backlog-reviewer.md',
      '.claude/agents/changeset-writer.md',
      '.claude/kit-templates/CLAUDE.md.template',
    ]) {
      expect(existsSync(join(root, rel)), `missing ${rel}`).toBeTruthy();
    }
  });

  it('does not stage the archivist template when the ledger module is off', () => {
    expect(
      existsSync(
        join(root, '.claude/kit-templates/agents/archivist.agent.md.template'),
      ),
    ).toBe(false);
  });

  it('gitignores everything under kit-templates except the .gitignore itself', () => {
    const templatesIgnore = readFileSync(
      join(root, '.claude/kit-templates/.gitignore'),
      'utf8',
    );
    expect(templatesIgnore).toMatch(/^\*$/m);
    expect(templatesIgnore).toMatch(/^!\.gitignore$/m);
  });

  it('records exactly the default module set in the manifest', () => {
    const manifest = manifestOf(root);
    for (const m of [
      'core',
      'lint-fix',
      'backlog',
      'changesets',
      'session-context',
      'rename',
    ]) {
      expect(manifest.modules.includes(m), `module ${m}`).toBeTruthy();
    }
    for (const m of ['reviewers', 'ledger', 'terse-style']) {
      expect(
        manifest.modules.includes(m),
        `unexpected module ${m}`,
      ).toBeFalsy();
    }
  });

  it('hashes manifest-tracked files with a sha256 digest', () => {
    const manifest = manifestOf(root);
    expect(manifest.files['.claude/scripts/guard-bash.mjs']).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it('writes a kit.config.json v2 with changesets configured for the base branch', () => {
    const config = readJson(kitConfigPath(root));
    expect(config.version).toBe(2);
    expect(config.changesets.enabled).toBe(true);
    expect(config.changesets.stopCheck).toBe(true);
    expect(config.changesets.baseBranch).toBe('main');
  });

  it('derives a target’s prefix and fixCommands, omitting changelogPath without the ledger module', () => {
    const config = readJson(kitConfigPath(root));
    const cityville = config.targets.find(
      (t: any) => t.packageName === '@fix/cityville',
    );
    expect(cityville.prefix).toBe('CITYVILLE');
    expect(cityville.fixCommands).toEqual(['fix']);
    expect(cityville.changelogPath).toBe(undefined);
  });

  it('wires every kit script into a settings.json hook', () => {
    const allCommands = allHookCommands(root).join('\n');
    for (const s of [
      'guard-bash',
      'lint-format-fix',
      'changeset-check',
      'session-context',
    ]) {
      expect(allCommands.includes(s), `hook ${s} wired`).toBeTruthy();
    }
  });

  it('does not create a settings.json.bak when settings.json did not pre-exist', () => {
    expect(existsSync(join(root, '.claude/settings.json.bak'))).toBe(false);
  });

  it('leaves settings.local.json untouched', () => {
    expect(readJson(join(root, '.claude/settings.local.json'))).toEqual({
      permissions: { allow: ['WebFetch(domain:example.com)'] },
    });
  });

  it('seeds CLAUDE.md with facts from the repo and no unfilled <PROJECT_NAME>-style template placeholder', () => {
    const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    expect(claudeMd.includes('@fix/studio')).toBeTruthy();
    expect(claudeMd.includes('changeset')).toBeTruthy();
    expect(/<[A-Z][A-Z_]{3,}>/.test(claudeMd)).toBe(false);
  });

  it('leaves .changeset byte-identical', () => {
    expect(treeHash(join(root, '.changeset'))).toBe(changesetHashBefore);
  });
});

describe('init --yes on a pnpm monorepo, run repeatedly', () => {
  it('produces an identical tree on a second --yes run', () => {
    const root = useRepo('pnpm-monorepo');
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    const after1 = treeHash(root);
    const r2 = runCli(['init', '--yes', root]);
    expect(r2.status, r2.stderr).toBe(0);
    expect(treeHash(root), 'second init changed the tree').toBe(after1);
  });

  it('writes nothing to the tree in --dry-run mode', () => {
    const root = useRepo('pnpm-monorepo');
    const before = treeHash(root);
    const r = runCli(['init', '--yes', '--dry-run', root]);
    expect(r.status).toBe(0);
    expect(treeHash(root)).toBe(before);
  });
});

describe('init --yes on an npm-single repo with pre-existing config', () => {
  let root: string;
  let claudeBefore: string;
  let settingsBefore: string;
  let initResult: RunResult;

  beforeEach(() => {
    root = useRepo('npm-single');
    claudeBefore = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    settingsBefore = readFileSync(join(root, '.claude/settings.json'), 'utf8');
    initResult = runCli(['init', '--yes', root]);
  });

  it('exits 0', () => {
    expect(initResult.status, initResult.stderr).toBe(0);
  });

  it('adds the managed CLAUDE.md block without touching any byte outside the markers', () => {
    const claudeAfter = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    expect(claudeAfter).toContain('<!-- claude-kit:claude-md start -->');
    const withoutBlock = claudeAfter.replace(
      /\n*<!-- claude-kit:claude-md start -->[\s\S]*?<!-- claude-kit:claude-md end -->\n*/,
      '\n\n',
    );
    expect(withoutBlock.trim()).toBe(claudeBefore.trim());
  });

  it('retires the hand-merge staging file', () => {
    expect(
      existsSync(join(root, '.claude/kit-templates/CLAUDE.additions.md')),
    ).toBe(false);
  });

  it('merges settings.json, keeping the user’s existing entries and adding the kit hook', () => {
    const settings = settingsOf(root);
    expect(settings.permissions?.allow?.[0]).toBe('Bash(echo hi)');
    expect(hookCommandsFor(settings, 'PreToolUse')[0]).toBe(
      'node   ./my-hook.js   --check',
    );
    expect(
      hookCommandsFor(settings, 'PreToolUse').some((command) =>
        command.includes('guard-bash.mjs'),
      ),
    ).toBeTruthy();
  });

  it('backs up the pre-merge settings.json to .bak', () => {
    expect(readFileSync(join(root, '.claude/settings.json.bak'), 'utf8')).toBe(
      settingsBefore,
    );
  });

  it('resolves a single root-level target using the existing lint:fix script', () => {
    const config = readJson(kitConfigPath(root));
    expect(config.targets.length).toBe(1);
    expect(config.targets[0].pathPrefix).toBe('');
    expect(config.targets[0].fixCommands).toEqual(['lint:fix']);
  });

  it('is idempotent on a second run without overwriting .bak', () => {
    const after1 = treeHash(root);
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    expect(treeHash(root)).toBe(after1);
  });
});

describe('init --yes --modules=-backlog on a non-js repo', () => {
  let root: string;
  let initResult: RunResult;

  beforeEach(() => {
    root = useRepo('non-js');
    initResult = runCli(['init', '--yes', '--modules=-backlog', root]);
  });

  it('exits 0', () => {
    expect(initResult.status, initResult.stderr).toBe(0);
  });

  it('enables core and session-context by default', () => {
    const manifest = manifestOf(root);
    expect(manifest.modules.includes('core')).toBeTruthy();
    expect(manifest.modules.includes('session-context')).toBeTruthy();
  });

  it('removes backlog when subtracted via --modules=-backlog', () => {
    const manifest = manifestOf(root);
    expect(
      manifest.modules.includes('backlog'),
      '--modules=-backlog removed it',
    ).toBeFalsy();
    expect(
      existsSync(join(root, '.claude/scripts/backlog-log.mjs')),
    ).toBeFalsy();
  });

  it('disables changesets and lint-fix for a repo with neither a changesets config nor fix scripts', () => {
    const manifest = manifestOf(root);
    expect(
      manifest.modules.includes('changesets'),
      'no changesets for non-js',
    ).toBeFalsy();
    expect(
      manifest.modules.includes('lint-fix'),
      'no fix scripts → off',
    ).toBeFalsy();
    expect(
      existsSync(join(root, '.claude/scripts/changeset-write.mjs')),
    ).toBeFalsy();
  });
});

describe('init --modules validation', () => {
  it('errors with exit 1 naming an unknown module', () => {
    const root = useRepo('non-js');
    const bad = runCli(['init', '--yes', '--modules=nonsense', root]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/Unknown module/);
  });
});

describe('init on an existing CLAUDE.md', () => {
  it('inserts a managed block right after the H1, leaving the heading and prose byte-identical on either side', () => {
    const root = useRepo('npm-single');
    const heading = '# single-app\n\n';
    const prose =
      'Pre-existing user CLAUDE.md — the kit must never edit this.\n';
    expect(readClaudeMd(root)).toBe(`${heading}${prose}`);

    expect(runCli(['init', '--yes', root]).status).toBe(0);

    const after = readClaudeMd(root);
    expect(after.startsWith(heading)).toBe(true);
    expect(after.endsWith(prose)).toBe(true);
    expect(after).toContain(REGION_START);
    expect(after).toContain(REGION_END);
    expect(after.indexOf(REGION_START)).toBeLessThan(after.indexOf(REGION_END));
    expect(after.indexOf(REGION_END)).toBeLessThan(after.indexOf(prose));
  });
});

describe('init on a repo with no CLAUDE.md', () => {
  it('seeds one with the managed markers', () => {
    const root = useRepo('non-js');
    expect(existsSync(claudeMdPath(root))).toBe(false);
    expect(runCli(['init', '--yes', root]).status).toBe(0);

    expect(existsSync(claudeMdPath(root))).toBe(true);
    const content = readClaudeMd(root);
    expect(content).toContain(REGION_START);
    expect(content).toContain(REGION_END);
    expect(content.indexOf(REGION_START)).toBeLessThan(
      content.indexOf(REGION_END),
    );
  });
});

describe('installing over an existing settings.json with user content', () => {
  let root: string;

  beforeEach(() => {
    root = useRepo('npm-single');
    seedUserSettings(root);
    expect(runCli(['init', '--yes', root]).status).toBe(0);
  });

  it('keeps the user’s own hooks in every event they were registered under', () => {
    const settings = settingsOf(root);
    expect(hookCommandsFor(settings, 'PreToolUse')).toContain(
      'node ./my-own-hook.js',
    );
    expect(hookCommandsFor(settings, 'Stop')).toContain(
      'node ./my-stop-hook.js',
    );
  });

  it('keeps the user’s existing permissions', () => {
    expect(settingsOf(root).permissions?.allow).toContain('Bash(echo mine)');
  });

  it('leaves an unrelated top-level key untouched', () => {
    expect(settingsOf(root).someUnrelatedKey).toEqual({ keepMe: true });
  });

  it('appends the kit’s hook after the user’s hook in a shared matcher group, never reordering it', () => {
    const group = (settingsOf(root).hooks?.PreToolUse ?? []).find(
      (g) => g.matcher === 'Bash',
    );
    expect(group?.hooks?.[0]?.command).toBe('node ./my-own-hook.js');
  });

  it('does not duplicate kit hook entries on a second install', () => {
    const once = hookCommandsFor(settingsOf(root), 'PreToolUse');
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    const twice = hookCommandsFor(settingsOf(root), 'PreToolUse');
    expect(twice).toEqual(once);
  });
});

describe('the settings.json backup', () => {
  it('is written once, before the first kit write, and is never overwritten by a later run', () => {
    const root = useRepo('npm-single');
    seedUserSettings(root);
    const original = readFileSync(join(root, '.claude/settings.json'), 'utf8');
    expect(runCli(['init', '--yes', root]).status).toBe(0);

    const backup = join(root, '.claude/settings.json.bak');
    expect(existsSync(backup)).toBe(true);
    expect(
      readFileSync(backup, 'utf8'),
      'the .bak must be the pristine pre-kit file',
    ).toBe(original);

    expect(runCli(['update', root]).status).toBe(0);
    expect(
      readFileSync(backup, 'utf8'),
      'a later run must not overwrite it',
    ).toBe(original);
  });
});

describe('installing over an unparseable settings.json', () => {
  it('refuses the install rather than clobbering the file', () => {
    const root = useRepo('npm-single');
    const path = join(root, '.claude/settings.json');
    writeFileSync(path, '{ this is not json\n');
    const before = readFileSync(path, 'utf8');

    const r = runCli(['init', '--yes', root]);
    expect(r.status, 'must refuse rather than clobber').not.toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});

describe('init below the git toplevel', () => {
  let root: string;
  let sub: string;
  let result: RunResult;

  beforeEach(() => {
    root = useRepo('pnpm-monorepo');
    sub = join(root, 'apps/studio');
    result = runCli(['init', '--yes', sub]);
  });

  it('refuses with exit 1, naming the git root problem and a cd fix', () => {
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/below the git root/);
    expect(result.stderr).toMatch(/cd .* npx claude-kit init/);
  });

  it('writes nothing to the subdirectory', () => {
    expect(existsSync(join(sub, '.claude'))).toBeFalsy();
  });
});

describe('init settings signature recorded in the manifest', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
  });

  it('signs the wired guard-bash hook', () => {
    const manifest = manifestOf(root);
    expect(
      manifest.settings.hooks.some((h: any) => h.script === 'guard-bash.mjs'),
    ).toBeTruthy();
  });

  it('signs a non-empty set of permissions', () => {
    const manifest = manifestOf(root);
    expect(manifest.settings.permissions.length > 0).toBeTruthy();
  });
});
