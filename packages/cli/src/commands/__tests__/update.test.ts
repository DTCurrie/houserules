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
  editHouseConfig,
  type HouseManifestShape,
  hookCommandsFor,
  readClaudeMd,
  readJson,
  REGION_END,
  REGION_START,
  type Settings,
  settingsOf,
  sha256,
} from '#test/installed-tree';
import { splitFrontmatter } from '../../core/frontmatter.js';
import { PRETTIERIGNORE_REGION } from '../../modules/prettier-guard.js';

/**
 * The manifest shape as these tests read it, where a body-owned rule's `files` entry is a
 * `{ body, frontmatter }` pair rather than a single hash string.
 */
interface ManifestShape {
  modules: string[];
  files: Record<string, string | { body: string; frontmatter: string }>;
}

function plantRetiredHookAlongsideUserHook(
  root: string,
  { hashMismatchesDisk = false }: { hashMismatchesDisk?: boolean } = {},
): { retired: string; settingsPath: string; manifestPath: string } {
  const retired = '.claude/scripts/compact-tool-output.mjs';
  const content = '// retired houserules hook\nprocess.exit(0);\n';
  writeFileSync(join(root, retired), content);
  const manifestPath = join(root, '.claude/houserules.manifest.json');
  const manifest = readJson<HouseManifestShape>(manifestPath);
  manifest.files[retired] = hashMismatchesDisk
    ? sha256('something else')
    : sha256(content);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const settingsPath = join(root, '.claude/settings.json');
  const settings = readJson<Settings>(settingsPath);
  settings.hooks ??= {};
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

describe('update without --force on a houserules script with a local edit', () => {
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
      'See what changed: npx houserules doctor --json',
    );
  });

  it('blames a formatter when several houserules files read as edited, with the update remedy', () => {
    editKitScripts(3);

    const result = runCli(['update', root]);

    expect(unwrapped(result.stdout)).toContain(
      'A repo-wide formatter run is the likely cause. Run `npx houserules update --force` to restore them',
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

describe('update --force on a houserules script with a local edit', () => {
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

  it('restores houserules version, discarding the local edit', () => {
    expect(readFileSync(guardPath, 'utf8')).not.toContain('my local tweak');
  });
});

describe('update on a kit-owned file that is stale relative to the shipped houserules content', () => {
  let root: string;
  let lintPath: string;
  let result: RunResult;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    lintPath = join(root, '.claude/scripts/lint-format-fix.mjs');
    writeFileSync(lintPath, '// OLD KIT VERSION\n');
    const manifestPath = join(root, '.claude/houserules.manifest.json');
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

  it('replaces the stale content with the current houserules version, since the file was unedited by the user', () => {
    const refreshed = readFileSync(lintPath, 'utf8');
    expect(refreshed).not.toContain('OLD KIT VERSION');
    expect(refreshed).toContain('loadConfigSafe');
  });
});

describe('update --dry-run on reference templates committed before they were gitignored', () => {
  let root: string;
  const reviewerTpl = '.claude/templates/agents/reviewer.agent.md.template';
  let result: RunResult;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    runIn(root, 'git', ['add', '-f', '.claude/templates']);
    runIn(root, 'git', ['commit', '-qm', 'committed templates']);
    result = runCli(['update', '--dry-run', root]);
  });

  it('exits 0', () => {
    expect(result.status, result.stderr).toBe(0);
  });

  it('leaves the template tracked in git', () => {
    expect(runIn(root, 'git', ['ls-files', reviewerTpl]).trim()).toBe(
      reviewerTpl,
    );
  });
});

describe('update on reference templates committed before they were gitignored', () => {
  let root: string;
  const reviewerTpl = '.claude/templates/agents/reviewer.agent.md.template';
  let result: RunResult;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    runIn(root, 'git', ['add', '-f', '.claude/templates']);
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
    expect(existsSync(join(root, reviewerTpl))).toBe(true);
  });

  it('keeps templates/.gitignore tracked', () => {
    expect(
      runIn(root, 'git', ['ls-files', '.claude/templates/.gitignore']).trim(),
    ).toBe('.claude/templates/.gitignore');
  });
});

describe('update on a ledger .jsonl committed before it was gitignored', () => {
  let root: string;
  const ledgerLog = '.claude/ledgers/backlog.jsonl';
  let onDiskBefore: string;
  let result: RunResult;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    mkdirSync(join(root, '.claude/ledgers'), { recursive: true });
    writeFileSync(
      join(root, ledgerLog),
      `${JSON.stringify({ id: 'B1', file: 'BACKLOG.md' })}\n`,
    );
    runIn(root, 'git', ['add', '-f', ledgerLog]);
    runIn(root, 'git', ['commit', '-qm', 'committed ledger log']);
    onDiskBefore = readFileSync(join(root, ledgerLog), 'utf8');
    result = runCli(['update', root]);
  });

  it('exits 0', () => {
    expect(result.status, result.stderr).toBe(0);
  });

  it('untracks the ledger log from git', () => {
    expect(runIn(root, 'git', ['ls-files', ledgerLog]).trim()).toBe('');
  });

  it('leaves the ledger log on disk byte-for-byte', () => {
    expect(readFileSync(join(root, ledgerLog), 'utf8')).toBe(onDiskBefore);
  });

  it('stages the untrack without committing it', () => {
    expect(runIn(root, 'git', ['status', '--porcelain']).trim()).not.toBe('');
  });

  it('reports where the durable record lives now', () => {
    expect(result.stdout.replace(/\s+/g, ' ')).toContain(
      'ledgers: untracked 1 ledger log(s) from git — kept on disk. Commit the staged removal to finish. The record now lives in the GitHub Project once `projects-sync.mjs push` has run.',
    );
  });
});

describe('update on a ledger .jsonl that is already untracked', () => {
  it('reports nothing about a ledger log', () => {
    const root = useInstalledRepo('pnpm-monorepo');

    const result = runCli(['update', root]);

    expect(result.stdout).not.toContain('ledger log');
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

describe('update on houserules scripts committed before they were gitignored', () => {
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
    expect(existsSync(join(root, guardScript))).toBe(true);
  });

  it('keeps .claude/scripts/.gitignore tracked', () => {
    expect(
      runIn(root, 'git', ['ls-files', '.claude/scripts/.gitignore']).trim(),
    ).toBe('.claude/scripts/.gitignore');
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
    const configPath = join(root, '.claude/houserules.config.json');
    const config = readJson<{ scripts?: { commit: boolean } }>(configPath);
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
    expect(runIn(root, 'git', ['ls-files', guardScript]).trim()).toBe(
      guardScript,
    );
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

describe('update on a repo with no prior houserules install', () => {
  it('refuses with exit 1 and points at the missing manifest', () => {
    const root = useRepo('non-js');
    const r = runCli(['update', root]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/houserules.manifest\.json/);
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
      '# single-app\n\nPre-existing user CLAUDE.md — houserules must never edit this.\n';
    writeFileSync(claudeMdPath(root), pristine);

    const configPath = join(root, '.claude/houserules.config.json');
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

describe('migrating a prior houserules hook entry', () => {
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

  it('preserves a user-edited variant of a houserules hook rather than duplicating it', () => {
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

function plantStaleSignatureEntry(
  root: string,
  { userEdited = false }: { userEdited?: boolean } = {},
): { manifestPath: string; settingsPath: string } {
  const event = 'PreToolUse';
  const matcher = 'StaleMatcher';
  const script = 'guard-bash.mjs';

  const settingsPath = join(root, '.claude/settings.json');
  const settings = settingsOf(root);
  const stockCommand = hookCommandsFor(settings, event).find((c) =>
    c.includes(script),
  )!;
  settings.hooks![event] = [
    ...(settings.hooks![event] ?? []),
    {
      matcher,
      hooks: [
        {
          type: 'command',
          command: userEdited
            ? `${stockCommand} --my-extra-flag`
            : stockCommand,
        },
      ],
    },
  ];
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  const manifestPath = join(root, '.claude/houserules.manifest.json');
  const manifest = readJson(manifestPath) as {
    settings?: {
      hooks: {
        event: string;
        matcher: string | null;
        script: string | null;
      }[];
      permissions: string[];
    };
  };
  manifest.settings ??= { hooks: [], permissions: [] };
  manifest.settings.hooks.push({ event, matcher, script });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return { manifestPath, settingsPath };
}

describe('update reconciling a stale but still-recognizable hook entry no current module declares', () => {
  it('drops the entry from settings.json even though its script still ships', () => {
    const root = useInstalledRepo('npm-single');
    plantStaleSignatureEntry(root);

    const result = runCli(['update', root]);

    expect(result.status, result.stderr).toBe(0);
    const settings = settingsOf(root);
    expect(
      (settings.hooks?.PreToolUse ?? []).some(
        (group) => group.matcher === 'StaleMatcher',
      ),
    ).toBe(false);
    expect(existsSync(join(root, '.claude/scripts/guard-bash.mjs'))).toBe(true);
  });

  it('no longer records the dropped tuple in the written manifest signature', () => {
    const root = useInstalledRepo('npm-single');
    const { manifestPath } = plantStaleSignatureEntry(root);

    expect(runCli(['update', root]).status).toBe(0);

    const manifest = readJson(manifestPath) as {
      settings?: {
        hooks: {
          event: string;
          matcher: string | null;
          script: string | null;
        }[];
      };
    };
    expect(
      manifest.settings?.hooks.some(
        (h) => h.matcher === 'StaleMatcher' && h.script === 'guard-bash.mjs',
      ),
    ).toBe(false);
  });

  it('preserves a hook the current modules still declare, at its own matcher', () => {
    const root = useInstalledRepo('npm-single');
    plantStaleSignatureEntry(root);

    expect(runCli(['update', root]).status).toBe(0);

    const after = hookCommandsFor(settingsOf(root), 'PreToolUse').filter((c) =>
      c.includes('guard-bash.mjs'),
    );
    expect(after).toHaveLength(1);
  });

  it('preserves a user-added hook with a non-kit command', () => {
    const root = useInstalledRepo('npm-single');
    plantStaleSignatureEntry(root);
    const settingsPath = join(root, '.claude/settings.json');
    const settings = settingsOf(root);
    settings.hooks!.PreToolUse = [
      ...(settings.hooks!.PreToolUse ?? []),
      { hooks: [{ type: 'command', command: 'node ./my-own-hook.js' }] },
    ];
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    expect(runCli(['update', root]).status).toBe(0);

    const after = hookCommandsFor(settingsOf(root), 'PreToolUse');
    expect(after.some((c) => c.includes('my-own-hook.js'))).toBe(true);
  });

  it('preserves a user-edited variant of the stale entry rather than dropping it', () => {
    const root = useInstalledRepo('npm-single');
    plantStaleSignatureEntry(root, { userEdited: true });

    expect(runCli(['update', root]).status).toBe(0);

    const settings = settingsOf(root);
    const staleGroup = (settings.hooks?.PreToolUse ?? []).find(
      (group) => group.matcher === 'StaleMatcher',
    );
    expect(staleGroup?.matcher, 'the user-edited entry must survive').toBe(
      'StaleMatcher',
    );
    expect(staleGroup!.hooks?.[0]?.command).toMatch(/--my-extra-flag/);
  });
});

describe('doctor and update on a retired, unmodified, wired hook script', () => {
  let root: string;
  let retired: string;
  let manifestPath: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    ({ retired, manifestPath } = plantRetiredHookAlongsideUserHook(root));
  });

  it('doctor exits 1, since a wired script no module ships spawns a dead process on every trigger', () => {
    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(1);
  });

  it('doctor reports the retired hook as still wired', () => {
    const r = runCli(['doctor', root]);
    expect(r.stdout).toMatch(
      /retired houserules hook script compact-tool-output\.mjs.*still wired/,
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
    expect(existsSync(join(root, retired))).toBe(true);
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
      expect(existsSync(join(root, retired))).toBe(false);
    });

    it('unwires the retired houserules hook from settings.json', () => {
      const cmds = hookCommandsFor(settingsOf(root), 'PostToolUse');
      expect(cmds.some((c) => c.includes('compact-tool-output'))).toBe(false);
    });

    it('preserves the user hook in settings.json', () => {
      const cmds = hookCommandsFor(settingsOf(root), 'PostToolUse');
      expect(cmds.some((c) => c.includes('user-hook.js'))).toBe(true);
    });

    it('drops the retired file from the manifest', () => {
      expect(retired in readJson<HouseManifestShape>(manifestPath).files).toBe(
        false,
      );
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
    expect(existsSync(join(root, retired))).toBe(true);
  });

  it('mentions the local edit in its output', () => {
    const r = runCli(['update', root]);
    expect(r.stdout).toMatch(/locally edited/);
  });

  it('removes the file when --force is passed', () => {
    const r = runCli(['update', '--force', root]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, retired))).toBe(false);
  });
});

describe('update when the install predates a new default module', () => {
  let root: string;
  let manifestPath: string;
  let result: RunResult;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo', { modules: '-session-context' });
    manifestPath = join(root, '.claude/houserules.manifest.json');
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
      readJson<HouseManifestShape>(manifestPath).modules.includes(
        'session-context',
      ),
    ).toBe(false);
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
    const manifestPath = join(root, '.claude/houserules.manifest.json');
    const manifest = readJson<ManifestShape>(manifestPath);
    manifest.modules = [...manifest.modules, 'backlog'];
    manifest.files['.claude/scripts/backlog-log.mjs'] = sha256(content);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    result = runCli(['update', root]);
  });

  it('exits 1 rather than silently deleting the module’s files', () => {
    expect(result.status).toBe(1);
  });

  it('names the plugin package that restores the module', () => {
    expect(result.stdout + result.stderr).toMatch(
      /@houserules\/plugin-backlog/,
    );
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
    const manifest = readJson<ManifestShape>(
      join(root, '.claude/houserules.manifest.json'),
    );
    expect(manifest.files[rulePath]).toEqual({
      body: expect.any(String),
      frontmatter: expect.any(String),
    });
  });
});

describe('update on a body-owned rule whose body houserules has since changed', () => {
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

    const manifestPath = join(root, '.claude/houserules.manifest.json');
    const manifest = readJson<ManifestShape>(manifestPath);
    manifest.files[rulePath] = {
      ...(manifest.files[rulePath] as { body: string; frontmatter: string }),
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
    manifestPath = join(root, '.claude/houserules.manifest.json');
    const manifest = readJson<ManifestShape>(manifestPath);
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
    const entry = readJson<ManifestShape>(manifestPath).files[rulePath];
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
  const link = join(FIXTURE_PLUGIN, 'node_modules', '@houserules', 'cli');
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
    editHouseConfig(root, (config) => {
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
    editHouseConfig(root, (config) => {
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
    editHouseConfig(root, (config) => {
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
    expect(unwrap(result.stdout)).toContain(
      'houserules files already up to date',
    );
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
      join(root, '.claude/houserules.config.json'),
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
    expect(existsSync(join(root, '.claude/houserules.manifest.json'))).toBe(
      false,
    );
  });
});

describe('update on a consumer-less install with a ledger .gitignore from before the gating', () => {
  it('prunes the file and leaves no empty .claude/ledgers/ behind', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    const ignoreContent = '*\n!.gitignore\n';
    mkdirSync(join(root, '.claude/ledgers'), { recursive: true });
    writeFileSync(join(root, '.claude/ledgers/.gitignore'), ignoreContent);
    const manifestPath = join(root, '.claude/houserules.manifest.json');
    const manifest = readJson<HouseManifestShape>(manifestPath);
    manifest.files['.claude/ledgers/.gitignore'] = sha256(ignoreContent);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    expect(runCli(['update', root]).status).toBe(0);

    expect(existsSync(join(root, '.claude/ledgers'))).toBe(false);
    expect(
      readJson<HouseManifestShape>(manifestPath).files[
        '.claude/ledgers/.gitignore'
      ],
    ).toBe(undefined);
  });
});

describe('update on an install with a pre-relocation settings.json.bak', () => {
  it('moves it into .claude/backups/ unchanged', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    writeFileSync(join(root, '.claude/settings.json.bak'), 'pristine-bytes\n');

    expect(runCli(['update', root]).status).toBe(0);

    expect(existsSync(join(root, '.claude/settings.json.bak'))).toBe(false);
    expect(
      readFileSync(join(root, '.claude/backups/settings.json.bak'), 'utf8'),
    ).toBe('pristine-bytes\n');
  });

  it('keeps the stray file when a backup already exists at the new location', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    writeFileSync(join(root, '.claude/settings.json.bak'), 'older-pristine\n');
    mkdirSync(join(root, '.claude/backups'), { recursive: true });
    writeFileSync(
      join(root, '.claude/backups/settings.json.bak'),
      'newer-backup\n',
    );

    expect(runCli(['update', root]).status).toBe(0);

    expect(readFileSync(join(root, '.claude/settings.json.bak'), 'utf8')).toBe(
      'older-pristine\n',
    );
    expect(
      readFileSync(join(root, '.claude/backups/settings.json.bak'), 'utf8'),
    ).toBe('newer-backup\n');
  });

  it('leaves the stray file alone on --dry-run', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    writeFileSync(join(root, '.claude/settings.json.bak'), 'pristine-bytes\n');

    expect(runCli(['update', '--dry-run', root]).status).toBe(0);

    expect(readFileSync(join(root, '.claude/settings.json.bak'), 'utf8')).toBe(
      'pristine-bytes\n',
    );
    expect(existsSync(join(root, '.claude/backups/settings.json.bak'))).toBe(
      false,
    );
  });
});
