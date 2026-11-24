import { beforeEach, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { hookCommand } from '@houserules/api';
import { useInstalledRepo, useRepo } from '#test/repo';
import { runCli, runIn, type RunResult } from '#test/run';
import {
  editHouseConfig,
  HOOK_WIRING_RELATIVE_PATH,
  type HouseManifestShape,
  dispatchedScriptsFor,
  hookCommandsFor,
  hookWiringOf,
  manifestOf,
  readJson,
  type Settings,
  settingsOf,
  sha256,
} from '#test/installed-tree';
import { splitFrontmatter } from '../../core/frontmatter.js';
import {
  COMMITTED_SCRIPTS,
  KIT_VERSION,
  makeLintScriptStale,
} from './update-test-support.js';

/** Plants a per-script PreToolUse guard-bash entry, the pre-dispatch wiring an older install carried. */
function plantGuardBashEntry(root: string, command: string): void {
  const settings = settingsOf(root);
  settings.hooks ??= {};
  settings.hooks.PreToolUse = [
    ...(settings.hooks.PreToolUse ?? []),
    { matcher: 'Bash', hooks: [{ type: 'command', command }] },
  ];
  writeFileSync(
    join(root, '.claude/settings.json'),
    `${JSON.stringify(settings, null, 2)}\n`,
  );
}

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

describe('migrating a prior houserules hook entry', () => {
  it('migrates the historical unguarded stock command onto the dispatcher', () => {
    const root = useInstalledRepo('npm-single');
    plantGuardBashEntry(
      root,
      'node "$CLAUDE_PROJECT_DIR/.claude/scripts/guard-bash.mjs"',
    );

    expect(runCli(['update', root]).status).toBe(0);
    const direct = hookCommandsFor(settingsOf(root), 'PreToolUse').filter((c) =>
      c.includes('guard-bash.mjs'),
    );
    expect(direct, 'no per-script guard-bash entry left in settings').toEqual(
      [],
    );
    expect(
      dispatchedScriptsFor(root, 'PreToolUse').filter(
        (script) => script === 'guard-bash.mjs',
      ),
      'exactly one dispatched guard-bash',
    ).toHaveLength(1);
  });

  it('preserves a user-edited variant of a houserules hook rather than duplicating it', () => {
    const root = useInstalledRepo('npm-single');
    plantGuardBashEntry(
      root,
      `${hookCommand('guard-bash.mjs', 'guard')} --my-extra-flag`,
    );

    expect(runCli(['update', root]).status).toBe(0);
    const after = hookCommandsFor(settingsOf(root), 'PreToolUse').filter((c) =>
      c.includes('guard-bash.mjs'),
    );
    expect(
      after,
      'exactly one guard-bash entry in settings, and it is the edited one',
    ).toHaveLength(1);
    expect(after[0]).toMatch(/--my-extra-flag/);
    expect(
      dispatchedScriptsFor(root, 'PreToolUse'),
      'the stock guard-bash is not dispatched beside the edited entry',
    ).not.toContain('guard-bash.mjs');
    expect(
      Object.keys(hookWiringOf(root).events),
      'hooks of other events are still dispatched',
    ).toContain('SessionStart');
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
  const stockCommand = hookCommand(script, 'guard');
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
      'stale matcher group dropped',
    ).toBe(false);
    expect(
      existsSync(join(root, '.claude/scripts/guard-bash.mjs')),
      'guard-bash.mjs still on disk',
    ).toBe(true);
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
      'stale tuple dropped from the manifest',
    ).toBe(false);
  });

  it('preserves a hook the current modules still declare, at its own matcher', () => {
    const root = useInstalledRepo('npm-single');
    plantStaleSignatureEntry(root);

    expect(runCli(['update', root]).status).toBe(0);

    expect(
      dispatchedScriptsFor(root, 'PreToolUse').filter(
        (script) => script === 'guard-bash.mjs',
      ),
    ).toHaveLength(1);
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
    expect(
      after.some((c) => c.includes('my-own-hook.js')),
      'user-added hook preserved',
    ).toBe(true);
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
    expect(existsSync(join(root, retired)), 'file not deleted').toBe(true);
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
      expect(existsSync(join(root, retired)), 'retired file deleted').toBe(
        false,
      );
    });

    it('unwires the retired houserules hook from settings.json', () => {
      const cmds = hookCommandsFor(settingsOf(root), 'PostToolUse');
      expect(
        cmds.some((c) => c.includes('compact-tool-output')),
        'retired hook unwired',
      ).toBe(false);
    });

    it('preserves the user hook in settings.json', () => {
      const cmds = hookCommandsFor(settingsOf(root), 'PostToolUse');
      expect(
        cmds.some((c) => c.includes('user-hook.js')),
        'user hook preserved',
      ).toBe(true);
    });

    it('drops the retired file from the manifest', () => {
      expect(
        retired in readJson<HouseManifestShape>(manifestPath).files,
        'file dropped from the manifest',
      ).toBe(false);
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
    expect(existsSync(join(root, retired)), 'file kept').toBe(true);
  });

  it('mentions the local edit in its output', () => {
    const r = runCli(['update', root]);
    expect(r.stdout).toMatch(/locally edited/);
  });

  it('removes the file when --force is passed', () => {
    const r = runCli(['update', '--force', root]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, retired)), 'file removed').toBe(false);
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
      'module not auto-enabled',
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
    editHouseConfig(root, (config) => {
      config.modules = manifest.modules;
    });

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
    expect(existsSync(retiredScript), 'retired module files left on disk').toBe(
      true,
    );
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

describe('update on an edited, ignored houserules file', () => {
  const unwrapped = (text: string): string => text.replace(/\s+/g, ' ');

  function skillDests(root: string): string[] {
    return Object.keys(manifestOf(root).files).filter((dest) =>
      dest.startsWith('.claude/skills/'),
    );
  }

  function editFile(root: string, dest: string): void {
    appendFileSync(join(root, dest), '\n<!-- my tweak -->\n');
  }

  it('offers eject to keep the edit and a delete-then-update to discard it, never --force', () => {
    const root = useInstalledRepo('pnpm-monorepo', { modules: 'ready,sweep' });
    const [dest] = skillDests(root);
    editFile(root, dest!);

    const out = unwrapped(runCli(['update', root]).stdout);

    expect(out).toContain(`npx houserules eject ${dest}`);
    expect(out).toContain(
      `${dest}: to discard your edit, delete the file and run \`npx houserules update\`, which recreates it`,
    );
    expect(out).not.toContain('doctor --fix --force');
  });

  it('offers neither line for an edited ejected file', () => {
    const root = useInstalledRepo('pnpm-monorepo', { modules: 'ready,sweep' });
    const [dest] = skillDests(root);
    editHouseConfig(root, (config) => {
      config.ejected = [dest];
    });
    editFile(root, dest!);

    const out = unwrapped(runCli(['update', root]).stdout);

    expect(out).not.toContain(`houserules eject ${dest}`);
    expect(out).not.toContain('to discard your edit');
  });

  it('offers neither line for an edited committed script', () => {
    const root = useInstalledRepo('pnpm-monorepo', COMMITTED_SCRIPTS);
    appendFileSync(join(root, '.claude/scripts/guard-bash.mjs'), '// tweak\n');

    const out = unwrapped(runCli(['update', root]).stdout);

    expect(out).toContain('differ from what houserules last wrote');
    expect(out).not.toContain('houserules eject');
    expect(out).not.toContain('to discard your edit');
  });

  it('counts only the un-ejected edit in the outro', () => {
    const root = useInstalledRepo('pnpm-monorepo', { modules: 'ready,sweep' });
    const [ejectedDest, keptDest] = skillDests(root);
    editHouseConfig(root, (config) => {
      config.ejected = [ejectedDest];
    });
    editFile(root, ejectedDest!);
    editFile(root, keptDest!);

    const out = unwrapped(runCli(['update', root]).stdout);

    expect(out).toContain(
      '1 locally-edited file(s) kept as-is (--force to overwrite)',
    );
  });

  describe('with --sync on a stale install', () => {
    it('appends the doctor hint when the kept file is ignored and not ejected', () => {
      const root = useInstalledRepo('pnpm-monorepo', {
        modules: 'ready,sweep',
      });
      makeLintScriptStale(root);
      editFile(root, skillDests(root)[0]!);

      const result = runCli(['update', '--sync', root]);

      expect(result.stdout).toBe(
        `[houserules] synced to ${KIT_VERSION}: 2 written, 1 kept (edited), run houserules doctor\n`,
      );
    });

    it('adds no hint when the kept file is ejected', () => {
      const root = useInstalledRepo('pnpm-monorepo', {
        modules: 'ready,sweep',
      });
      makeLintScriptStale(root);
      const [dest] = skillDests(root);
      editHouseConfig(root, (config) => {
        config.ejected = [dest];
      });
      editFile(root, dest!);

      const result = runCli(['update', '--sync', root]);

      expect(result.stdout).not.toContain('run houserules doctor');
    });
  });
});

describe('update over an install wired with one settings entry per script', () => {
  const USER_HOOK = { type: 'command', command: 'node ./my-own-hook.js' };
  const EDITED_VARIANT = {
    type: 'command',
    command: 'node .claude/scripts/session-context.mjs --verbose',
  };
  let root: string;

  function plantLegacyPerScriptWiring(repoRoot: string): void {
    const legacySettings = {
      ...settingsOf(repoRoot),
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              USER_HOOK,
              {
                type: 'command',
                command: hookCommand('guard-bash.mjs', 'guard'),
                onFailure: 'block',
              },
            ],
          },
        ],
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: hookCommand('payload-sync.mjs', 'bootstrap'),
              },
              EDITED_VARIANT,
            ],
          },
        ],
      },
    };
    writeFileSync(
      join(repoRoot, '.claude/settings.json'),
      `${JSON.stringify(legacySettings, null, 2)}\n`,
    );
  }

  beforeEach(() => {
    root = useRepo('npm-single');
    runCli(['init', '--yes', root]);
    plantLegacyPerScriptWiring(root);

    expect(runCli(['update', root]).status).toBe(0);
  });

  it('removes the per-script entries houserules wrote', () => {
    const scripts = Object.keys(settingsOf(root).hooks ?? {}).flatMap((event) =>
      hookCommandsFor(settingsOf(root), event)
        .filter((command) => command.includes('[ -f '))
        .map((command) => /[\w-]+\.mjs/.exec(command)?.[0]),
    );

    expect(scripts.filter((script) => script !== 'hook-dispatch.mjs')).toEqual(
      [],
    );
  });

  it('keeps the user’s own hook first in its group', () => {
    const group = (settingsOf(root).hooks?.PreToolUse ?? []).find(
      (g) => g.matcher === 'Bash',
    );

    expect(group?.hooks?.[0]).toEqual(USER_HOOK);
  });

  it('keeps a user’s edited variant of a dispatched script’s command', () => {
    expect(hookCommandsFor(settingsOf(root), 'SessionStart')).toContain(
      EDITED_VARIANT.command,
    );
  });

  it('writes the SessionStart dispatcher with the bootstrap fallback', () => {
    expect(hookCommandsFor(settingsOf(root), 'SessionStart')).toContain(
      hookCommand('hook-dispatch.mjs', 'bootstrap'),
    );
  });
});

describe('update --sync over a stale hook-wiring.json', () => {
  it('rewrites the wiring the plan produces', () => {
    const root = useRepo('npm-single');
    runCli(['init', '--yes', root]);
    const canonical = readFileSync(
      join(root, HOOK_WIRING_RELATIVE_PATH),
      'utf8',
    );
    writeFileSync(
      join(root, HOOK_WIRING_RELATIVE_PATH),
      '{ "version": 1, "events": {} }\n',
    );

    expect(runCli(['update', '--sync', root]).status).toBe(0);

    expect(readFileSync(join(root, HOOK_WIRING_RELATIVE_PATH), 'utf8')).toBe(
      canonical,
    );
  });
});
