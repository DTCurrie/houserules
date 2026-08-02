import { beforeEach, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { useInstalledRepo, useRepo } from '#test/repo';
import { runCli, runIn, type RunResult } from '#test/run';
import {
  claudeMdPath,
  hookCommandsFor,
  readClaudeMd,
  readJson,
  REGION_END,
  REGION_START,
  settingsOf,
  sha256,
} from '#test/installed-tree';

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
    root = useInstalledRepo('pnpm-monorepo', { modules: '-backlog' });
    manifestPath = join(root, '.claude/kit-manifest.json');
    result = runCli(['update', root]);
  });

  it('exits 0', () => {
    expect(result.status, result.stderr).toBe(0);
  });

  it('advertises the new default module by name with the flag to enable it', () => {
    expect(result.stdout).toMatch(
      /New default module\(s\) available[\s\S]*backlog/,
    );
    expect(result.stdout).toMatch(/modules --modules=[\w,-]*backlog/);
  });

  it('never auto-enables the advertised module', () => {
    expect(readJson(manifestPath).modules.includes('backlog')).toBeFalsy();
  });
});
