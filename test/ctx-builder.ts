import type { Ctx, Target } from '../src/detect.js';
import type { Answers } from '../src/module-def.js';

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
    ...overrides,
  };
}
