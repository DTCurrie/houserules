import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { onTestFinished } from 'vitest';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { runCli, runIn } from './run.js';

/**
 * Which synthetic repo shape to generate.
 *
 * - `pnpm-monorepo` is schoolyard-shaped: workspace yaml, catalog blocks with
 *   `catalogMode: strict`, empty workspace dirs, two packages whose fix scripts diverge
 *   from the root's, a changesets config and two pending changesets but no
 *   `@changesets/cli` devDependency, only settings.local.json, and no CLAUDE.md.
 * - `pnpm-flow-monorepo` covers the workspace-file shapes `pnpm-monorepo` does not: an
 *   inline flow sequence, a `**` glob whose package is nested under an intermediate
 *   directory, and a negation. Each silently produced the wrong package set before the
 *   parser fixes. `workspaces.test.ts` covers the parsers in isolation, this covers detect
 *   through to targets end to end.
 * - `npm-single` is a root package with only `lint:fix`, no TypeScript or changesets, a
 *   pre-existing settings.json carrying a user hook with odd whitespace plus permissions,
 *   and an existing CLAUDE.md.
 * - `pnpm-single` is a single-package pnpm repo with a lockfile and no workspace yaml,
 *   whose fixers are `lint:fix` plus a writing `format` alongside a separate
 *   `format:check`. The shape a past detect regression broke: `filterFlag` must be empty
 *   and the writing `format` must be detected as a fixer.
 * - `npm-single-prettier` is a minimal root package with a `lint:fix` script and a
 *   `prettier` devDependency, so `ctx.prettier` is true and the `.prettierignore`
 *   protection block plans in. It carries no lockfile, no pre-existing `CLAUDE.md`, and
 *   no pre-existing `.claude/settings.json`, unlike `npm-single`.
 * - `committed-scripts` is a pre-gitignore install: `.claude/scripts/*.mjs` and
 *   `.claude/settings.json` tracked by git, which the migration has to detect and stage
 *   out.
 * - `non-js` is a git repo with no package.json.
 */
type RepoShape =
  | 'pnpm-monorepo'
  | 'pnpm-flow-monorepo'
  | 'npm-single'
  | 'npm-single-prettier'
  | 'pnpm-single'
  | 'committed-scripts'
  | 'non-js';

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function gitInit(root: string): void {
  runIn(root, 'git', ['init', '-q', '-b', 'main']);
  runIn(root, 'git', ['config', 'user.email', 'kit-test@example.com']);
  runIn(root, 'git', ['config', 'user.name', 'houserules test']);
  runIn(root, 'git', ['add', '-A']);
  runIn(root, 'git', ['commit', '-qm', 'fixture: initial']);
}

const PKG_SCRIPTS = {
  dev: 'vite dev',
  fix: 'wireit',
  'lint:fix': 'eslint . --fix',
  'format:fix': 'prettier . --write',
  format: 'prettier . --check',
};

/**
 * The packages `buildRepo` writes for each shape whose `.claude/houserules.config.json` seed gets
 * combined with `opts.plugins` (see `useInstalledRepo`). `buildRepo` writes each
 * package.json and source file straight from this list, so `pluginFixtureFacts` below
 * derives `packageManager` and `targets` from it instead of restating them.
 */
const PLUGIN_FIXTURE_PACKAGES: Partial<
  Record<
    RepoShape,
    {
      packageManagerField: string;
      packages: Array<{
        dir: string;
        packageName: string;
        name: string;
        prefix: string;
        label: string;
        scripts: Record<string, string>;
        sourceFile: { rel: string; content: string };
      }>;
    }
  >
> = {
  'pnpm-monorepo': {
    packageManagerField: 'pnpm@11.5.0',
    packages: [
      {
        dir: 'games/cityville',
        packageName: '@fix/cityville',
        name: 'cityville',
        prefix: 'CITYVILLE',
        label: 'Cityville',
        scripts: PKG_SCRIPTS,
        sourceFile: { rel: 'src/game.ts', content: 'export const game = 1;\n' },
      },
      {
        dir: 'apps/studio',
        packageName: '@fix/studio',
        name: 'studio',
        prefix: 'STUDIO',
        label: 'Studio',
        scripts: PKG_SCRIPTS,
        sourceFile: { rel: 'src/main.ts', content: 'export const app = 1;\n' },
      },
    ],
  },
  'npm-single': {
    packageManagerField: 'npm',
    packages: [
      {
        dir: '',
        packageName: 'single-app',
        name: 'single-app',
        prefix: 'SINGLEAPP',
        label: 'Single App',
        scripts: { 'lint:fix': 'eslint . --fix', test: 'node --test' },
        sourceFile: { rel: 'src/index.js', content: 'module.exports = 1;\n' },
      },
    ],
  },
};

/**
 * Picks the scripts that write fixes, mirroring the single rule the fixtures above
 * exercise: a `fix` script wins outright, otherwise `lint:fix` runs alone.
 */
function fixCommandsFor(scripts: Record<string, string>): string[] {
  if (scripts.fix) return ['fix'];
  return scripts['lint:fix'] ? ['lint:fix'] : [];
}

/**
 * What `init`'s own detection would have produced for `packageManager` and `targets`,
 * derived from {@link PLUGIN_FIXTURE_PACKAGES} rather than restated, since that table is
 * the same data `buildRepo` writes to disk for these shapes.
 */
function pluginFixtureFacts(shape: RepoShape):
  | {
      packageManager: string;
      targets: Array<{
        name: string;
        prefix: string;
        packageName: string;
        pathPrefix: string;
        sourcePath: string;
        label: string;
        fixCommands?: string[];
      }>;
    }
  | undefined {
  const spec = PLUGIN_FIXTURE_PACKAGES[shape];
  if (!spec) return undefined;
  const at = spec.packageManagerField.lastIndexOf('@');
  const packageManager =
    at > 0 ? spec.packageManagerField.slice(0, at) : spec.packageManagerField;
  return {
    packageManager,
    targets: spec.packages.map((p) => ({
      name: p.name,
      prefix: p.prefix,
      packageName: p.packageName,
      pathPrefix: p.dir ? `${p.dir}/` : '',
      sourcePath: p.dir
        ? `${p.dir}/${dirname(p.sourceFile.rel)}`
        : dirname(p.sourceFile.rel),
      label: p.label,
      fixCommands: fixCommandsFor(p.scripts),
    })),
  };
}

/**
 * A bare synthetic repo with no houserules installed, removed after the current test.
 *
 * Reach for {@link useInstalledRepo} instead unless the test's subject is `init` itself, since
 * staging by running `init` couples the suite to a command it is not testing.
 *
 * @returns The repo root, removed after the current test including on failure.
 */
export function useRepo(shape: RepoShape): string {
  const root = buildRepo(shape);
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/**
 * A repo with houserules ALREADY INSTALLED, staged by copying a snapshot rather than by
 * running `init`.
 *
 * Prefer this everywhere. Staging by running `init` makes a suite fail when `init` breaks,
 * naming the wrong subject. The copy preserves the git index byte for byte, which `update`'s
 * untracking tests depend on.
 *
 * Use {@link useRepo} plus a real `init` when the subject IS `init`, or when the test re-runs
 * `init` over a tree it has already mutated.
 *
 * @param opts.modules Passed through as `--modules=`. Part of the cache key. A plugin's
 * module is selected as `<alias>/<moduleId>`, matching `opts.plugins`' aliases.
 * @param opts.plugins Plugins to declare in `.claude/houserules.config.json` before `init` runs, as
 * `{ name, alias }` pairs. `name` must be a filesystem path to the plugin package, since
 * test cannot resolve a plugin by npm name. Written as the whole seed file, so `init`
 * reads the declared plugin while resolving `--modules=` and renders everything else, the
 * CLAUDE.md region, scripts, and settings, with full knowledge of the modules selected. Part
 * of the cache key.
 * @param opts.config Merged into `.claude/houserules.config.json` after `init`, for keys a fixture
 * needs set that neither `init`'s detection nor its module set determines. Part of the cache
 * key.
 * @param opts.moduleOptions Passed through as repeated `--module-option <id>=<values>` flags,
 * keyed by module id. This has to be a flag rather than a `config` key: `config` is patched in
 * AFTER `init` has already planned, so a module whose `plan()` branches on its options would
 * never see it. Part of the cache key.
 * @returns The repo root, removed after the current test.
 */
export function useInstalledRepo(
  shape: RepoShape,
  opts: InstalledRepoOptions = {},
): string {
  const key = cacheKeyFor(shape, opts);
  const hashedKey = createHash('sha256').update(key).digest('hex').slice(0, 16);
  const snapshot = join(snapshotRoot(), hashedKey);

  // On disk, not a module-level Map: vitest gives every test FILE a fresh module registry, so
  // an in-memory cache never survives across files and each would clobber the shared snapshot.
  if (!existsSync(snapshot)) buildSnapshot(shape, opts, snapshot, key);

  const root = mkdtempSync(join(tmpdir(), `kit-${shape}-`));
  cpSync(snapshot, root, { recursive: true });
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

interface InstalledRepoOptions {
  modules?: string;
  plugins?: Array<{ name: string; alias: string }>;
  config?: Record<string, unknown>;
  moduleOptions?: Record<string, string[]>;
}

/** The cache key `useInstalledRepo` keys its on-disk snapshot by. */
function cacheKeyFor(shape: RepoShape, opts: InstalledRepoOptions): string {
  const pluginTag = (opts.plugins ?? [])
    .map((p) => `${p.name}=${p.alias}`)
    .join(',');
  const configTag = opts.config ? JSON.stringify(opts.config) : '';
  const optionTag = opts.moduleOptions
    ? JSON.stringify(opts.moduleOptions)
    : '';
  return `${shape}::${opts.modules ?? ''}::${pluginTag}::${configTag}::${optionTag}`;
}

/**
 * Builds one shape into `snapshot` by running `init` over a staging copy, then publishes it
 * atomically. Only called on a cache miss; the caller is responsible for the existence check.
 */
function buildSnapshot(
  shape: RepoShape,
  opts: InstalledRepoOptions,
  snapshot: string,
  key: string,
): void {
  const staging = buildRepo(shape);

  // A plugin's modules can only be selected once the plugin is declared in
  // `.claude/houserules.config.json`, but that file is a seed `init` never overwrites once
  // present. Writing it here, before the one `init` call, means `init` reads the
  // plugin declaration to build its module registry and resolve `--modules=` and, since
  // that same registry drives everything else the run touches: the CLAUDE.md region,
  // scripts, and settings all see the full module set. The one thing the seed write
  // itself skips over is `renderHouseConfig`, which never runs because the seed's
  // destination already exists, so the two boolean toggles it would have derived from
  // the module set (`changesets.enabled`/`stopCheck`, `ledger.enabled`) are computed
  // here instead, the same way `hasModule` does it: an id matches bare or by
  // `/<bareId>` suffix, which is how a plugin-qualified module (`cs/changesets`) reads
  // as `changesets`.
  if (opts.plugins?.length) {
    seedPluginConfig(staging, shape, opts, key);
  }

  const args = ['init', '--yes'];
  if (opts.modules) args.push(`--modules=${opts.modules}`);
  for (const [id, values] of Object.entries(opts.moduleOptions ?? {})) {
    args.push('--module-option', `${id}=${values.join(',')}`);
  }
  const result = runCli([...args, staging]);
  if (result.status !== 0) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(
      `useInstalledRepo(${key}) could not stage: init exited ${result.status}\n${result.stderr}`,
    );
  }
  if (opts.config) patchConfig(staging, opts.config);
  publishSnapshot(staging, snapshot, key);
}

/** Writes `.claude/houserules.config.json` for a plugin-declaring fixture, ahead of the `init` call. */
function seedPluginConfig(
  staging: string,
  shape: RepoShape,
  opts: InstalledRepoOptions,
  key: string,
): void {
  const facts = pluginFixtureFacts(shape);
  if (!facts) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(
      `useInstalledRepo(${key}): no PLUGIN_FIXTURE_PACKAGES entry for shape "${shape}". ` +
        'A plugin declaration writes the whole houserules.config.json seed up front, which ' +
        'needs packageManager/targets derived for the shape. Add one in repo.ts.',
    );
  }
  const tokens = (opts.modules ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t && !t.startsWith('-'));
  const hasToken = (bareId: string) =>
    tokens.some((t) => t === bareId || t.endsWith(`/${bareId}`));
  const targets = hasToken('ledger')
    ? facts.targets.map((t) => ({
        ...t,
        changelogPath: `.claude/changelogs/${t.name}.md`,
        logPath: `.claude/changelogs/${t.name}.log`,
      }))
    : facts.targets;
  write(
    staging,
    '.claude/houserules.config.json',
    json({
      version: 2,
      packageManager: facts.packageManager,
      targets,
      changesets: {
        enabled: hasToken('changesets'),
        stopCheck: hasToken('changesets'),
        baseBranch: 'main',
      },
      ledger: { enabled: hasToken('ledger') },
      plugins: opts.plugins,
    }),
  );
}

/**
 * Publishes `staging` to `snapshot` atomically. Two workers can miss the same key at once, so
 * each builds into a private directory and the first rename wins.
 */
function publishSnapshot(staging: string, snapshot: string, key: string): void {
  const pending = `${snapshot}.${process.pid}.pending`;
  cpSync(staging, pending, { recursive: true });
  rmSync(staging, { recursive: true, force: true });
  try {
    renameSync(pending, snapshot);
    writeFileSync(`${snapshot}.key`, key);
  } catch (e) {
    rmSync(pending, { recursive: true, force: true });
    // A loser's rename fails with ENOTEMPTY once the winner's snapshot directory exists,
    // which is success. Any other failure means no worker actually published, so rethrow
    // rather than let the caller proceed as if one had.
    if (!existsSync(snapshot)) {
      throw new Error(
        `useInstalledRepo(${key}): could not publish snapshot: ${(e as Error).message}`,
        { cause: e },
      );
    }
  }
}

/**
 * Merges `patch` into the staged `.claude/houserules.config.json`, one level deep so a fixture can
 * set `changesets.stopCheck` without restating the whole block.
 */
function patchConfig(root: string, patch: Record<string, unknown>): void {
  const configPath = join(root, '.claude/houserules.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<
    string,
    unknown
  >;
  for (const [key, value] of Object.entries(patch)) {
    const existing = config[key];
    config[key] =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>), ...(value as object) }
        : value;
  }
  writeFileSync(configPath, json(config));
}

// global-setup.ts creates this and removes it in teardown. Falling back to a local
// mkdtemp keeps a directly-invoked suite working, but defeats the on-disk cache
// entirely: every call returns a fresh directory, so no snapshot is ever shared and
// each one leaks until the OS reclaims tmpdir().
function snapshotRoot(): string {
  const fromSetup = process.env.KIT_TEST_SNAPSHOT_ROOT;
  if (fromSetup) {
    mkdirSync(fromSetup, { recursive: true });
    return fromSetup;
  }
  return mkdtempSync(join(tmpdir(), 'kit-snapshots-'));
}

/** Writes one shape into a fresh mkdtemp directory. Callers own the cleanup. */
function buildRepo(shape: RepoShape): string {
  const root = mkdtempSync(join(tmpdir(), `kit-${shape}-`));

  if (shape === 'pnpm-monorepo') {
    write(
      root,
      'pnpm-workspace.yaml',
      [
        'packages:',
        '  - packages/*',
        '  - toolkits/*',
        '  - games/*',
        '  - apps/*',
        '',
        'catalogMode: strict',
        '',
        'catalog:',
        "  typescript: '6.0.3'",
        '',
        'catalogs:',
        '  three-stack:',
        "    three: '0.160.0'",
        '',
      ].join('\n'),
    );
    const monorepo = PLUGIN_FIXTURE_PACKAGES['pnpm-monorepo'];
    if (!monorepo) throw new Error('unreachable: pnpm-monorepo has no spec');
    write(
      root,
      'package.json',
      json({
        name: 'fix-root',
        private: true,
        packageManager: monorepo.packageManagerField,
        scripts: {
          build: 'wireit',
          verify: 'wireit',
          fix: 'wireit',
          'format:check': 'prettier --check .',
          change: 'pnpx @changesets/cli',
        },
        devDependencies: { typescript: 'catalog:' },
      }),
    );
    write(root, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
    write(root, 'packages/.gitkeep', '');
    write(root, 'toolkits/.gitkeep', '');
    for (const pkg of monorepo.packages) {
      write(
        root,
        `${pkg.dir}/package.json`,
        json({ name: pkg.packageName, private: true, scripts: pkg.scripts }),
      );
      write(root, `${pkg.dir}/${pkg.sourceFile.rel}`, pkg.sourceFile.content);
    }
    write(
      root,
      '.changeset/config.json',
      json({
        changelog: '@changesets/cli/changelog',
        commit: false,
        access: 'restricted',
        baseBranch: 'main',
      }),
    );
    write(root, '.changeset/README.md', '# Changesets\n');
    write(
      root,
      '.changeset/fuzzy-pandas-smile.md',
      '---\n"@fix/studio": patch\n---\n\nPending one.\n',
    );
    write(
      root,
      '.changeset/brave-lions-jump.md',
      '---\n"@fix/cityville": minor\n---\n\nPending two.\n',
    );
    write(
      root,
      '.claude/settings.local.json',
      json({ permissions: { allow: ['WebFetch(domain:example.com)'] } }),
    );
  } else if (shape === 'npm-single') {
    const single = PLUGIN_FIXTURE_PACKAGES['npm-single']?.packages[0];
    if (!single) throw new Error('unreachable: npm-single has no spec');
    write(
      root,
      'package.json',
      json({
        name: single.packageName,
        version: '1.0.0',
        scripts: single.scripts,
      }),
    );
    write(
      root,
      'package-lock.json',
      json({ name: single.packageName, lockfileVersion: 3 }),
    );
    write(root, single.sourceFile.rel, single.sourceFile.content);
    write(
      root,
      'CLAUDE.md',
      '# single-app\n\nPre-existing user CLAUDE.md. houserules must never edit this.\n',
    );
    // The hook's script must exist, or doctor's install-hygiene check warns and every
    // suite asserting warning counts on this shape absorbs an unrelated finding.
    write(root, 'my-hook.js', 'process.exit(0);\n');
    write(
      root,
      '.claude/settings.json',
      `${JSON.stringify(
        {
          permissions: { allow: ['Bash(echo hi)'] },
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [
                  { type: 'command', command: 'node   ./my-hook.js   --check' },
                ],
              },
            ],
          },
        },
        null,
        4,
      )}\n`,
    );
  } else if (shape === 'npm-single-prettier') {
    write(
      root,
      'package.json',
      json({
        name: 'single-app-prettier',
        version: '1.0.0',
        scripts: { 'lint:fix': 'eslint . --fix', test: 'node --test' },
        devDependencies: { prettier: '^3.0.0' },
      }),
    );
    write(root, 'src/index.js', 'module.exports = 1;\n');
  } else if (shape === 'pnpm-flow-monorepo') {
    write(
      root,
      'pnpm-workspace.yaml',
      'packages: ["libs/**", "!libs/legacy"]\n',
    );
    write(
      root,
      'package.json',
      json({
        name: 'flow-root',
        private: true,
        packageManager: 'pnpm@11.5.0',
        scripts: { 'lint:fix': 'eslint . --fix' },
      }),
    );
    write(root, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
    // Nested one level deeper than any `*` glob reaches. Only `**` finds it.
    write(
      root,
      'libs/group/nested/package.json',
      json({ name: '@flow/nested', scripts: PKG_SCRIPTS }),
    );
    write(root, 'libs/group/nested/src/index.ts', 'export const x = 1;\n');
    write(
      root,
      'libs/plain/package.json',
      json({ name: '@flow/plain', scripts: PKG_SCRIPTS }),
    );
    write(
      root,
      'libs/legacy/package.json',
      json({ name: '@flow/legacy', scripts: PKG_SCRIPTS }),
    );
  } else if (shape === 'pnpm-single') {
    write(
      root,
      'package.json',
      json({
        name: 'solo',
        version: '1.0.0',
        scripts: {
          'lint:fix': 'eslint . --fix',
          format: 'prettier --write .',
          'format:check': 'prettier --check .',
          test: 'node --test',
        },
      }),
    );
    write(root, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
    write(root, 'src/index.js', 'export const x = 1;\n');
  } else if (shape === 'committed-scripts') {
    // The state every pre-gitignore install is in: houserules scripts tracked by git.
    // gitInit() commits everything below, so these land in the index. This is what
    // the migration has to detect and stage out.
    write(
      root,
      'package.json',
      json({ name: 'legacy-install', version: '1.0.0' }),
    );
    for (const name of [
      'changeset-check.mjs',
      'session-context.mjs',
      'guard-bash.mjs',
    ]) {
      write(root, `.claude/scripts/${name}`, '#!/usr/bin/env node\n');
    }
    write(root, '.claude/settings.json', json({ hooks: {} }));
  } else if (shape === 'non-js') {
    write(root, 'README.md', '# not a js repo\n');
  } else {
    throw new Error(`unknown repo shape: ${shape}`);
  }

  gitInit(root);
  return root;
}

/** Content hash of a whole tree, ignoring `.git`. Asserts a dry run wrote nothing. */
export function treeHash(root: string): string {
  const hash = createHash('sha256');
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name === '.git') continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else {
        hash.update(abs.slice(root.length));
        hash.update(readFileSync(abs));
      }
    }
  };
  walk(root);
  return hash.digest('hex');
}
