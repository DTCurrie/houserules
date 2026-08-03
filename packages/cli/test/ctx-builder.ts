import type { Ctx, Target } from '../src/detect.js';
import type { Answers, ModuleDef } from '../src/module-def.js';
import type { RegisteredModule, Registry } from '../src/plugin-registry.js';

/**
 * A registry over `builtIns`, plus any already-namespaced plugin modules. Built here rather
 * than through `buildRegistry` so a suite that only needs `buildPlan` to run does not have to
 * stage a resolvable plugin package on disk.
 */
export function makeRegistry(
  builtIns: ModuleDef[],
  pluginModules: RegisteredModule[] = [],
): Registry {
  const modules: RegisteredModule[] = [
    ...builtIns.map((def) => ({ id: def.id, def, source: null })),
    ...pluginModules,
  ];
  return {
    modules,
    plugins: pluginModules
      .map((m) => m.source)
      .filter((s) => s !== null)
      .filter((s, i, all) => all.indexOf(s) === i),
    get: (id) => modules.find((m) => m.id === id),
  };
}

export function makeTarget(overrides: Partial<Target> = {}): Target {
  return {
    name: 'core',
    prefix: 'CORE',
    packageName: 'my-repo',
    pathPrefix: '',
    sourcePath: 'src',
    label: 'Core',
    ...overrides,
  };
}

/**
 * The shape `detect()` produces, for the pure planning and rendering functions that consume it.
 *
 * Defaults describe the plainest repo the kit supports: npm, single package, a git repo with
 * commits, no changesets, no existing `.claude/`. A test overrides only the field it is about.
 */
export function makeCtx(overrides: Partial<Ctx> = {}): Ctx {
  return {
    root: '/repo',
    git: { isRepo: true, top: '/repo', hasCommits: true, branch: 'main' },
    packageManager: { name: 'npm', source: 'lockfile' },
    rootPkg: { name: 'my-repo' },
    isMonorepo: false,
    packages: [],
    targets: [],
    typescript: false,
    prettier: false,
    changesets: {
      configExists: false,
      config: null,
      pendingCount: 0,
      devDep: false,
      rootScript: null,
      invocation: 'absent',
      baseBranch: 'main',
    },
    pnpmCatalogModeStrict: false,
    claude: {
      dirExists: false,
      settingsExists: false,
      settings: null,
      settingsParseError: null,
      settingsLocalExists: false,
      claudeMdExists: false,
      manifest: null,
      kitConfig: null,
      agents: [],
      skills: [],
    },
    ...overrides,
  };
}

export function makeAnswers(overrides: Partial<Answers> = {}): Answers {
  return {
    moduleIds: ['core'],
    targets: [makeTarget()],
    seedChangesetConfig: false,
    moduleOptions: {},
    ...overrides,
  };
}
