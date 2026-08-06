import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo, useRepo } from '#test/repo';
import { runCli, runIn, type RunResult } from '#test/run';
import {
  claudeMdPath,
  editKitConfig,
  hookCommandsFor,
  readClaudeMd,
  readJson,
  REGION_END,
  REGION_START,
  settingsOf,
  sha256,
} from '#test/installed-tree';
import { splitFrontmatter } from '../../core/frontmatter.js';
import { PRETTIERIGNORE_REGION } from '../../modules/prettier-guard.js';

function plantRetiredHookAlongsideUserHook(
  root: string,
  { hashMismatchesDisk = false }: { hashMismatchesDisk?: boolean } = {},
): { retired: string; settingsPath: string; manifestPath: string } {
  const retired = '.claude/scripts/compact-tool-output.mjs';
  const content = '// retired kit hook\nprocess.exit(0);\n';
  writeFileSync(join(root, retired), content);
  const manifestPath = join(root, '.claude/kit-manifest.json');
  const manifest = readJson(manifestPath);
  manifest.files[retired] = hashMismatchesDisk
    ? sha256('something else')
    : sha256(content);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const settingsPath = join(root, '.claude/settings.json');
  const settings = readJson(settingsPath);
  settings.hooks.PostToolUse = [
    {
      matcher: 'Bash',
      hooks: [
        {
          type: 'command',
          command:
            'node "$CLAUDE_PROJECT_DIR/.claude/scripts/compact-tool-output.mjs"',
        },
        { type: 'command', command: 'node ./user-hook.js' },
      ],
    },
  ];
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { retired, settingsPath, manifestPath };
}

describe('update without --force on a kit script with a local edit', () => {
  let root: string;
  let guardPath: string;
  let edited: string;
  let result: RunResult;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
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

describe('update reporting the local edits it kept', () => {
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
    root = useInstalledRepo('pnpm-monorepo');
  });

  it('points at the diff doctor already computes, so --force is not the only lever', () => {
    editKitScripts(1);

    const result = runCli(['update', root]);

    expect(unwrapped(result.stdout)).toContain(
      'See what changed: npx agent-kit doctor --json',
    );
  });

  it('blames a formatter when several kit files read as edited, with the update remedy', () => {
    editKitScripts(3);

    const result = runCli(['update', root]);

    expect(unwrapped(result.stdout)).toContain(
      'A repo-wide formatter run is the likely cause. Run `npx agent-kit update --force` to restore them',
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

describe('update --force on a kit script with a local edit', () => {
  let root: string;
  let guardPath: string;
  let result: RunResult;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    guardPath = join(root, '.claude/scripts/guard-bash.mjs');
    appendFileSync(guardPath, '// my local tweak\n');
    result = runCli(['update', '--force', root]);
  });

  it('exits 0', () => {
    expect(result.status, result.stderr).toBe(0);
  });

  it('restores the kit version, discarding the local edit', () => {
    expect(readFileSync(guardPath, 'utf8')).not.toContain('my local tweak');
  });
});

describe('update on a kit-owned file that is stale relative to the shipped kit content', () => {
  let root: string;
  let lintPath: string;
  let result: RunResult;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    lintPath = join(root, '.claude/scripts/lint-format-fix.mjs');
    writeFileSync(lintPath, '// OLD KIT VERSION\n');
    const manifestPath = join(root, '.claude/kit-manifest.json');
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

  it('replaces the stale content with the current kit version, since the file was unedited by the user', () => {
    const refreshed = readFileSync(lintPath, 'utf8');
    expect(refreshed).not.toContain('OLD KIT VERSION');
    expect(refreshed).toContain('loadConfigSafe');
  });
});

describe('update --dry-run on reference templates committed before they were gitignored', () => {
  let root: string;
  const reviewerTpl = '.claude/kit-templates/agents/reviewer.agent.md.template';
  let result: RunResult;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    runIn(root, 'git', ['add', '-f', '.claude/kit-templates']);
    runIn(root, 'git', ['commit', '-qm', 'committed templates']);
    result = runCli(['update', '--dry-run', root]);
  });

  it('exits 0', () => {
    expect(result.status, result.stderr).toBe(0);
  });

  it('leaves the template tracked in git', () => {
    expect(runIn(root, 'git', ['ls-files', reviewerTpl]).trim()).toBeTruthy();
  });
});

describe('update on reference templates committed before they were gitignored', () => {
  let root: string;
  const reviewerTpl = '.claude/kit-templates/agents/reviewer.agent.md.template';
  let result: RunResult;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    runIn(root, 'git', ['add', '-f', '.claude/kit-templates']);
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
    expect(existsSync(join(root, reviewerTpl))).toBeTruthy();
  });

  it('keeps kit-templates/.gitignore tracked', () => {
    expect(
      runIn(root, 'git', [
        'ls-files',
        '.claude/kit-templates/.gitignore',
      ]).trim(),
    ).toBeTruthy();
  });
});

describe('init on a fresh pnpm monorepo', () => {
  it('gitignores .claude/scripts so compiled scripts are never committed', () => {
    const root = useRepo('pnpm-monorepo');
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    expect(existsSync(join(root, '.claude/scripts/.gitignore'))).toBe(true);
    expect(
      runIn(root, 'git', ['ls-files', '.claude/scripts/guard-bash.mjs']).trim(),
    ).toBe('');
  });
});

describe('update on kit scripts committed before they were gitignored', () => {
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
    expect(existsSync(join(root, guardScript))).toBeTruthy();
  });

  it('keeps .claude/scripts/.gitignore tracked', () => {
    expect(
      runIn(root, 'git', ['ls-files', '.claude/scripts/.gitignore']).trim(),
    ).toBeTruthy();
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
    const configPath = join(root, '.claude/kit.config.json');
    const config = readJson(configPath);
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
    expect(existsSync(join(root, '.claude/scripts/.gitignore'))).toBe(false);
  });

  it('leaves the already-tracked scripts tracked rather than untracking them', () => {
    expect(runIn(root, 'git', ['ls-files', guardScript]).trim()).toBeTruthy();
  });
});

describe('update on a repo with a legacy ledger still outside .claude/ledgers', () => {
  const unwrapped = (text: string): string => text.replace(/\s+/g, ' ');

  it('names the backlog command to run when .claude/backlog.jsonl is still there', () => {
    const root = useInstalledRepo('npm-single');
    writeFileSync(
      join(root, '.claude/backlog.jsonl'),
      `${JSON.stringify({ id: 'B1', file: 'BACKLOG.md' })}\n`,
    );

    const result = runCli(['update', root]);

    expect(unwrapped(result.stdout)).toContain(
      'node .claude/scripts/backlog-log.mjs list',
    );
    expect(unwrapped(result.stdout)).toContain(
      'node .claude/scripts/backlog-log.mjs render',
    );
  });

  it('names the decisions command to run when .claude/decisions.log is still there', () => {
    const root = useInstalledRepo('npm-single');
    writeFileSync(join(root, '.claude/decisions.log'), '');

    const result = runCli(['update', root]);

    expect(unwrapped(result.stdout)).toContain(
      'node .claude/scripts/decision-log.mjs list',
    );
  });

  it('says nothing about a legacy ledger when there is none', () => {
    const root = useInstalledRepo('npm-single');

    const result = runCli(['update', root]);

    expect(unwrapped(result.stdout)).not.toContain('decision-log.mjs');
    expect(unwrapped(result.stdout)).not.toContain('backlog-log.mjs');
  });

  it('names the command on a dry run too', () => {
    const root = useInstalledRepo('npm-single');
    writeFileSync(
      join(root, '.claude/backlog.jsonl'),
      `${JSON.stringify({ id: 'B1', file: 'BACKLOG.md' })}\n`,
    );

    const result = runCli(['update', '--dry-run', root]);

    expect(unwrapped(result.stdout)).toContain('backlog-log.mjs');
  });
});

describe('update on a repo with no prior kit install', () => {
  it('refuses with exit 1 and points at the missing manifest', () => {
    const root = useRepo('non-js');
    const r = runCli(['update', root]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/kit-manifest\.json/);
  });
});

describe('update on a CLAUDE.md edited outside the markers', () => {
  it('preserves prose added above and below the block byte-for-byte', () => {
    const root = useInstalledRepo('npm-single');

    const installed = readClaudeMd(root);
    const startIdx = installed.indexOf(REGION_START);
    const endIdx = installed.indexOf(REGION_END) + REGION_END.length;
    const prefix = installed.slice(0, startIdx);
    const suffix = installed.slice(endIdx);

    const editedPrefix = `${prefix}Extra note added above the block by the user.\n`;
    const editedSuffix = `${suffix}\nExtra note added below the block by the user.\n`;
    const edited = `${editedPrefix}${installed.slice(startIdx, endIdx)}${editedSuffix}`;
    writeFileSync(claudeMdPath(root), edited);

    expect(runCli(['update', root]).status).toBe(0);

    const after = readClaudeMd(root);
    expect(after.startsWith(editedPrefix)).toBe(true);
    expect(after.endsWith(editedSuffix)).toBe(true);
    expect(after).toContain(REGION_START);
    expect(after).toContain(REGION_END);
  });
});

describe('update run twice in a row', () => {
  it('leaves CLAUDE.md byte-identical between the two runs', () => {
    const root = useInstalledRepo('npm-single');
    expect(runCli(['update', root]).status).toBe(0);
    const once = readClaudeMd(root);
    expect(runCli(['update', root]).status).toBe(0);
    expect(readClaudeMd(root)).toBe(once);
  });
});

describe('claudeMd.managed: false', () => {
  it('leaves an existing CLAUDE.md completely untouched by update', () => {
    const root = useInstalledRepo('npm-single');
    const pristine =
      '# single-app\n\nPre-existing user CLAUDE.md — the kit must never edit this.\n';
    writeFileSync(claudeMdPath(root), pristine);

    const configPath = join(root, '.claude/kit.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<
      string,
      unknown
    >;
    config.claudeMd = { managed: false };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    expect(runCli(['update', root]).status).toBe(0);
    expect(readClaudeMd(root)).toBe(pristine);
  });
});

describe('migrating a prior kit hook entry', () => {
  it('upgrades the historical unguarded stock command to the guarded form', () => {
    const root = useInstalledRepo('npm-single');

    const path = join(root, '.claude/settings.json');
    const settings = settingsOf(root);
    for (const group of settings.hooks?.PreToolUse ?? []) {
      for (const hook of group.hooks ?? []) {
        if (hook.command?.includes('guard-bash.mjs')) {
          hook.command =
            'node "$CLAUDE_PROJECT_DIR/.claude/scripts/guard-bash.mjs"';
        }
      }
    }
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);

    expect(runCli(['update', root]).status).toBe(0);
    const after = hookCommandsFor(settingsOf(root), 'PreToolUse').filter((c) =>
      c.includes('guard-bash.mjs'),
    );
    expect(after, 'exactly one guard-bash entry').toHaveLength(1);
    expect(after[0], 'the entry must now be the guarded form').toMatch(
      /^\[ -f /,
    );
  });

  it('preserves a user-edited variant of a kit hook rather than duplicating it', () => {
    const root = useInstalledRepo('npm-single');

    const path = join(root, '.claude/settings.json');
    const settings = settingsOf(root);
    for (const group of settings.hooks?.PreToolUse ?? []) {
      for (const hook of group.hooks ?? []) {
        if (hook.command?.includes('guard-bash.mjs')) {
          hook.command = `${hook.command} --my-extra-flag`;
        }
      }
    }
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);

    expect(runCli(['update', root]).status).toBe(0);
    const after = hookCommandsFor(settingsOf(root), 'PreToolUse').filter((c) =>
      c.includes('guard-bash.mjs'),
    );
    expect(
      after,
      'exactly one guard-bash entry, and it is the edited one',
    ).toHaveLength(1);
    expect(after[0]).toMatch(/--my-extra-flag/);
  });
});

describe('doctor and update on a retired, unmodified, wired hook script', () => {
  let root: string;
  let retired: string;
  let settingsPath: string;
  let manifestPath: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    ({ retired, settingsPath, manifestPath } =
      plantRetiredHookAlongsideUserHook(root));
  });

  it('doctor exits 1, since a wired script no module ships spawns a dead process on every trigger', () => {
    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(1);
  });

  it('doctor reports the retired hook as still wired', () => {
    const r = runCli(['doctor', root]);
    expect(r.stdout).toMatch(
      /retired kit hook script compact-tool-output\.mjs.*still wired/,
    );
  });

  it('doctor reports the leftover file as orphaned', () => {
    const r = runCli(['doctor', root]);
    expect(r.stdout).toMatch(/compact-tool-output\.mjs: orphaned/);
  });

  it('update --dry-run mentions the prune but writes nothing', () => {
    const r = runCli(['update', '--dry-run', root]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/compact-tool-output\.mjs/);
    expect(existsSync(join(root, retired))).toBeTruthy();
  });

  describe('after a real update', () => {
    let updateResult: RunResult;

    beforeEach(() => {
      updateResult = runCli(['update', root]);
    });

    it('exits 0', () => {
      expect(updateResult.status, updateResult.stderr).toBe(0);
    });

    it('deletes the retired file', () => {
      expect(existsSync(join(root, retired))).toBeFalsy();
    });

    it('unwires the retired kit hook from settings.json', () => {
      const cmds = (readJson(settingsPath).hooks.PostToolUse ?? []).flatMap(
        (g: any) => g.hooks.map((h: any) => h.command),
      );
      expect(
        cmds.some((c: string) => c.includes('compact-tool-output')),
      ).toBeFalsy();
    });

    it('preserves the user hook in settings.json', () => {
      const cmds = (readJson(settingsPath).hooks.PostToolUse ?? []).flatMap(
        (g: any) => g.hooks.map((h: any) => h.command),
      );
      expect(cmds.some((c: string) => c.includes('user-hook.js'))).toBeTruthy();
    });

    it('drops the retired file from the manifest', () => {
      expect(retired in readJson(manifestPath).files).toBeFalsy();
    });

    it('leaves doctor clean again', () => {
      expect(runCli(['doctor', root]).stdout).not.toMatch(
        /compact-tool-output/,
      );
    });
  });
});

describe('update on a retired hook script with local edits', () => {
  let root: string;
  let retired: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    ({ retired } = plantRetiredHookAlongsideUserHook(root, {
      hashMismatchesDisk: true,
    }));
  });

  it('keeps the file, since its hash no longer matches the manifest', () => {
    const r = runCli(['update', root]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, retired))).toBeTruthy();
  });

  it('mentions the local edit in its output', () => {
    const r = runCli(['update', root]);
    expect(r.stdout).toMatch(/locally edited/);
  });

  it('removes the file when --force is passed', () => {
    const r = runCli(['update', '--force', root]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, retired))).toBeFalsy();
  });
});

describe('update when the install predates a new default module', () => {
  let root: string;
  let manifestPath: string;
  let result: RunResult;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo', { modules: '-session-context' });
    manifestPath = join(root, '.claude/kit-manifest.json');
    result = runCli(['update', root]);
  });

  it('exits 0', () => {
    expect(result.status, result.stderr).toBe(0);
  });

  it('advertises the new default module by name with the flag to enable it', () => {
    expect(result.stdout).toMatch(
      /New default module\(s\) available[\s\S]*session-context/,
    );
    expect(result.stdout).toMatch(/modules --modules=[\w,-]*session-context/);
  });

  it('never auto-enables the advertised module', () => {
    expect(
      readJson(manifestPath).modules.includes('session-context'),
    ).toBeFalsy();
  });
});

describe('update on an install whose manifest names a retired module', () => {
  let root: string;
  let retiredScript: string;
  let result: RunResult;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    retiredScript = join(root, '.claude/scripts/backlog-log.mjs');
    const content = '// a retired module file left on disk\n';
    writeFileSync(retiredScript, content);
    const manifestPath = join(root, '.claude/kit-manifest.json');
    const manifest = readJson(manifestPath);
    manifest.modules = [...manifest.modules, 'backlog'];
    manifest.files['.claude/scripts/backlog-log.mjs'] = sha256(content);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    result = runCli(['update', root]);
  });

  it('exits 1 rather than silently deleting the module’s files', () => {
    expect(result.status).toBe(1);
  });

  it('names the plugin package that restores the module', () => {
    expect(result.stdout + result.stderr).toMatch(/@agent-kit\/plugin-backlog/);
  });

  it('leaves the retired module’s files on disk', () => {
    expect(existsSync(retiredScript)).toBe(true);
  });
});

describe('update on a body-owned rule with a trimmed frontmatter', () => {
  const rulePath = '.claude/rules/code-cleanliness.md';
  let root: string;
  let trimmedFrontmatter: string;

  beforeEach(() => {
    root = useInstalledRepo('npm-single', { modules: 'code-cleanliness' });
    const { body } = splitFrontmatter(
      readFileSync(join(root, rulePath), 'utf8'),
    );
    trimmedFrontmatter = "---\npaths:\n  - '**/*.test.ts'\n---\n";
    writeFileSync(join(root, rulePath), trimmedFrontmatter + body);
    runCli(['update', root]);
  });

  it('preserves the trimmed frontmatter byte for byte', () => {
    const { frontmatter } = splitFrontmatter(
      readFileSync(join(root, rulePath), 'utf8'),
    );
    expect(frontmatter).toBe(trimmedFrontmatter);
  });

  it('records the manifest entry as a body/frontmatter hash pair', () => {
    const manifest = readJson(join(root, '.claude/kit-manifest.json'));
    expect(manifest.files[rulePath]).toEqual({
      body: expect.any(String),
      frontmatter: expect.any(String),
    });
  });
});

describe('update on a body-owned rule whose body the kit has since changed', () => {
  const rulePath = '.claude/rules/code-cleanliness.md';
  let root: string;
  let trimmedFrontmatter: string;
  let currentBody: string;

  beforeEach(() => {
    root = useInstalledRepo('npm-single', { modules: 'code-cleanliness' });
    currentBody = splitFrontmatter(
      readFileSync(join(root, rulePath), 'utf8'),
    ).body;
    trimmedFrontmatter = "---\npaths:\n  - '**/*.test.ts'\n---\n";
    const olderBody = '# an older version of the testing rule\n';
    writeFileSync(join(root, rulePath), trimmedFrontmatter + olderBody);

    const manifestPath = join(root, '.claude/kit-manifest.json');
    const manifest = readJson(manifestPath);
    manifest.files[rulePath] = {
      ...manifest.files[rulePath],
      body: sha256(olderBody),
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    runCli(['update', root]);
  });

  it('rewrites the body to the current payload content', () => {
    const { body } = splitFrontmatter(
      readFileSync(join(root, rulePath), 'utf8'),
    );
    expect(body).toBe(currentBody);
  });

  it('leaves the trimmed frontmatter untouched', () => {
    const { frontmatter } = splitFrontmatter(
      readFileSync(join(root, rulePath), 'utf8'),
    );
    expect(frontmatter).toBe(trimmedFrontmatter);
  });
});

describe('update on a body-owned rule recorded with a legacy whole-file manifest hash', () => {
  const rulePath = '.claude/rules/code-cleanliness.md';
  let root: string;
  let manifestPath: string;
  let result: RunResult;

  beforeEach(() => {
    root = useInstalledRepo('npm-single', { modules: 'code-cleanliness' });
    manifestPath = join(root, '.claude/kit-manifest.json');
    const manifest = readJson(manifestPath);
    manifest.files[rulePath] = sha256(
      readFileSync(join(root, rulePath), 'utf8'),
    );
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    result = runCli(['update', root]);
  });

  it('exits 0', () => {
    expect(result.status, result.stderr).toBe(0);
  });

  it('does not report it as a local edit', () => {
    expect(result.stdout).not.toMatch(/kept as-is/);
  });

  it('rewrites the manifest entry to the body/frontmatter hash shape', () => {
    const entry = readJson(manifestPath).files[rulePath];
    expect(entry).toEqual({
      body: expect.any(String),
      frontmatter: expect.any(String),
    });
  });
});

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURE_PLUGIN = join(KIT_ROOT, 'test/plugin-fixture');
const OPTION_MODULE = 'fixture/fixture-langs';

function ensureFixtureSelfLink(): void {
  const link = join(FIXTURE_PLUGIN, 'node_modules', '@agent-kit', 'cli');
  if (existsSync(link)) return;
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(KIT_ROOT, link, 'dir');
}

describe('update against an install whose option selection was never recorded', () => {
  let root: string;

  beforeEach(() => {
    ensureFixtureSelfLink();
    root = useRepo('npm-single');
    runCli(['init', '--yes', root]);
    editKitConfig(root, (config) => {
      (config as Record<string, unknown>).plugins = [
        { name: FIXTURE_PLUGIN, alias: 'fixture' },
      ];
    });
    runCli([
      'modules',
      '--yes',
      `--modules=${OPTION_MODULE}`,
      '--module-option',
      `${OPTION_MODULE}=alpha,beta`,
      root,
    ]);
    editKitConfig(root, (config) => {
      delete (config as Record<string, unknown>).moduleOptions;
    });
  });

  it('exits 1 rather than retiring files the fallback selection would not produce', () => {
    expect(runCli(['update', root]).status).toBe(1);
  });

  it('leaves the file the unrecorded selection installed', () => {
    runCli(['update', root]);

    expect(existsSync(join(root, '.claude/fixture-lang-beta.md'))).toBe(true);
  });

  it('names the module and a runnable command that settles it', () => {
    const result = runCli(['update', root]);

    expect(result.stderr).toMatch(/No recorded option selection/);
    expect(result.stderr).toMatch(/--reconfigure=fixture\/fixture-langs/);
  });

  it('proceeds under --force, which accepts the defaults', () => {
    expect(runCli(['update', '--force', root]).status).toBe(0);
  });

  it('proceeds once the selection is recorded, keeping every selected file', () => {
    runCli([
      'modules',
      '--yes',
      `--reconfigure=${OPTION_MODULE}`,
      '--module-option',
      `${OPTION_MODULE}=alpha,beta`,
      root,
    ]);

    expect(runCli(['update', root]).status).toBe(0);

    expect(existsSync(join(root, '.claude/fixture-lang-beta.md'))).toBe(true);
  });
});

describe('update, given a plugin module whose payload-dist file is missing', () => {
  const unwrap = (text: string): string => text.replace(/\s+/g, ' ');
  let root: string;
  let pluginCopy: string;
  let missingRuleSrc: string;
  let result: RunResult;

  beforeEach(() => {
    ensureFixtureSelfLink();
    pluginCopy = mkdtempSync(join(tmpdir(), 'kit-broken-plugin-'));
    cpSync(FIXTURE_PLUGIN, pluginCopy, { recursive: true });
    root = useRepo('npm-single');
    runCli(['init', '--yes', root]);
    editKitConfig(root, (config) => {
      (config as Record<string, unknown>).plugins = [
        { name: pluginCopy, alias: 'fixture' },
      ];
    });
    expect(
      runCli(['modules', '--yes', '--modules=fixture/fixture-core', root])
        .status,
    ).toBe(0);
    missingRuleSrc = join(pluginCopy, 'payload-dist/rules/fixture-rule.md');
    rmSync(missingRuleSrc);
    result = runCli(['update', root]);
  });

  afterEach(() => {
    rmSync(pluginCopy, { recursive: true, force: true });
  });

  it('exits 1, since the plugin was not fully refreshed', () => {
    expect(result.status).toBe(1);
  });

  it('names the plugin that owns the missing payload file', () => {
    expect(unwrap(result.stdout)).toContain(pluginCopy);
  });

  it('says a payload build produces the missing file', () => {
    expect(unwrap(result.stdout)).toMatch(/payload/i);
    expect(unwrap(result.stdout)).toMatch(/build/i);
  });

  it('keeps the missing payload path in the message byte for byte', () => {
    expect(result.stdout).toContain(missingRuleSrc);
  });

  it("still renders the healthy built-in modules' plan instead of aborting everything", () => {
    expect(unwrap(result.stdout)).toContain('kit files already up to date');
  });

  it('keeps the missing path on the same line as its list marker', () => {
    expect(result.stdout).toContain(`- ${missingRuleSrc}`);
  });
});

describe('init, given a plugin module whose payload-dist file is missing', () => {
  const unwrap = (text: string): string => text.replace(/\s+/g, ' ');
  let root: string;
  let pluginCopy: string;
  let result: RunResult;

  beforeEach(() => {
    ensureFixtureSelfLink();
    pluginCopy = mkdtempSync(join(tmpdir(), 'kit-broken-plugin-init-'));
    cpSync(FIXTURE_PLUGIN, pluginCopy, { recursive: true });
    rmSync(join(pluginCopy, 'payload-dist/rules/fixture-rule.md'));
    root = useRepo('npm-single');
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(
      join(root, '.claude/kit.config.json'),
      JSON.stringify({
        version: 2,
        packageManager: 'npm',
        plugins: [{ name: pluginCopy, alias: 'fixture' }],
        targets: [],
      }),
    );
    result = runCli([
      'init',
      '--yes',
      '--modules=core,fixture/fixture-core',
      root,
    ]);
  });

  afterEach(() => {
    rmSync(pluginCopy, { recursive: true, force: true });
  });

  it('exits 1 rather than installing what it can', () => {
    expect(result.status).toBe(1);
  });

  it('names the plugin that owns the missing payload file', () => {
    expect(unwrap(result.stdout)).toContain(pluginCopy);
  });

  it('writes no manifest, so no module is recorded as installed without its files', () => {
    expect(existsSync(join(root, '.claude/kit-manifest.json'))).toBe(false);
  });
});
