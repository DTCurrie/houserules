import type { CheckResult, Ctx, Finding } from '@houserules/api';
import semver from 'semver';

/**
 * The newest `eslint` major on npm when the peer ranges below were read (`eslint@10.15.0`,
 * 2026-11-19). An undeclared `eslint`, or a range semver cannot read such as `workspace:*` or
 * `catalog:`, is taken as this, because that is what a fresh install resolves to.
 */
const CURRENT_ESLINT_RANGE = '^10.0.0';

/** One package that satisfies a requirement, and the `eslint` peer range it declares. */
interface LinterCandidate {
  /** The package name a repo declares. */
  name: string;
  /** What the hint tells the user to install, pinned where the latest rejects an older eslint. */
  install: string;
  /** The package's `eslint` peer range, copied from npm. Absent when it has no `eslint` peer. */
  eslintPeer?: string;
}

/** Packages that each satisfy one requirement. The first whose peer range fits is the hint. */
type Requirement = readonly [LinterCandidate, ...LinterCandidate[]];

// Peer ranges as read from npm on 2026-11-19, from eslint-plugin-jsx-a11y 6.10.2 and
// eslint-plugin-jsx-a11y-x 0.2.0.
const JSX_A11Y: Requirement = [
  {
    name: 'eslint-plugin-jsx-a11y',
    install: 'eslint-plugin-jsx-a11y',
    eslintPeer: '^3 || ^4 || ^5 || ^6 || ^7 || ^8 || ^9',
  },
  {
    name: 'eslint-plugin-jsx-a11y-x',
    install: 'eslint-plugin-jsx-a11y-x',
    eslintPeer: '^9.0.0 || ^10.0.0',
  },
];

// Every eslint-plugin-astro release from 2.0.0 to 3.2.1 peers the first range. The 1.x line,
// 1.0.1 to 1.7.0, peers the second.
const ASTRO_PLUGIN: Requirement = [
  {
    name: 'eslint-plugin-astro',
    install: 'eslint-plugin-astro',
    eslintPeer: '>=10.0.0',
  },
  {
    name: 'eslint-plugin-astro',
    install: 'eslint-plugin-astro@1',
    eslintPeer: '>=8.57.0',
  },
];

/**
 * A markup framework, and the accessibility linting a repo using it should have. The plugin
 * ships routing and reasoning. The mechanical checking belongs to these, and every one of them
 * is better at it than anything houserules would write. A framework is covered when every one
 * of its requirements has a declared package.
 */
interface FrameworkLinters {
  framework: string;
  dependencies: readonly string[];
  requires: readonly Requirement[];
}

const LINTERS_BY_FRAMEWORK: readonly FrameworkLinters[] = [
  {
    framework: 'react',
    dependencies: ['react', 'next', 'preact'],
    requires: [JSX_A11Y],
  },
  {
    framework: 'vue',
    dependencies: ['vue', 'nuxt'],
    requires: [
      [
        {
          name: 'eslint-plugin-vuejs-accessibility',
          install: 'eslint-plugin-vuejs-accessibility',
          // As read from npm for 2.6.3 on 2026-11-19.
          eslintPeer:
            '^5.0.0 || ^6.0.0 || ^7.0.0 || ^8.0.0 || ^9.0.0 || ^10.0.0',
        },
      ],
    ],
  },
  {
    framework: 'svelte',
    dependencies: ['svelte'],
    // Svelte checks accessibility in the compiler, so the tool to have is the one that
    // surfaces those warnings outside the dev server rather than a separate lint plugin.
    requires: [[{ name: 'svelte-check', install: 'svelte-check' }]],
  },
  {
    framework: 'astro',
    dependencies: ['astro'],
    // eslint-plugin-astro is what applies the accessibility rules to .astro files, so an
    // accessibility plugin without it, or a bare parser, checks nothing.
    requires: [ASTRO_PLUGIN, JSX_A11Y],
  },
];

/**
 * Every dependency declared anywhere in the repo, root and workspace packages alike, with each
 * version range it is declared at.
 */
function declaredDependencies(ctx: Ctx): Map<string, string[]> {
  const declared = new Map<string, string[]>();
  const manifests = [ctx.rootPkg, ...ctx.packages.map((entry) => entry.pkg)];
  for (const manifest of manifests) {
    if (!manifest || typeof manifest !== 'object') continue;
    for (const field of ['dependencies', 'devDependencies'] as const) {
      const bag: unknown = manifest[field];
      if (!bag || typeof bag !== 'object') continue;
      for (const [name, range] of Object.entries(bag)) {
        const ranges = declared.get(name) ?? [];
        if (typeof range === 'string') ranges.push(range);
        declared.set(name, ranges);
      }
    }
  }
  return declared;
}

/** The `eslint` ranges the repo declares, each read as the current major where semver cannot. */
function declaredEslintRanges(ranges: readonly string[]): string[] {
  if (ranges.length === 0) return [CURRENT_ESLINT_RANGE];
  return ranges.map(
    (range) => semver.validRange(range) ?? CURRENT_ESLINT_RANGE,
  );
}

/** True when every version each declared range allows also satisfies the candidate's peer. */
function admitsAll(
  candidate: LinterCandidate,
  declaredRanges: readonly string[],
): boolean {
  const peer = candidate.eslintPeer;
  if (peer === undefined) return true;
  return declaredRanges.every((range) => semver.subset(range, peer));
}

/** True when each declared range allows at least one version the candidate's peer admits. */
function overlapsAll(
  candidate: LinterCandidate,
  declaredRanges: readonly string[],
): boolean {
  const peer = candidate.eslintPeer;
  if (peer === undefined) return true;
  return declaredRanges.every((range) => semver.intersects(range, peer));
}

/**
 * The package to name in the install hint: the first whose `eslint` peer range admits every
 * declared range. Failing that, aim at the version an install resolves to, the current major
 * when a declared range reaches it, else a version each declared range shares with the peer.
 */
function hintFor(
  requirement: Requirement,
  declaredRanges: readonly string[],
): string {
  const fitsEveryDeclared = requirement.find((candidate) =>
    admitsAll(candidate, declaredRanges),
  );
  if (fitsEveryDeclared) return fitsEveryDeclared.install;

  const reachesCurrent = declaredRanges.some((range) =>
    semver.intersects(range, CURRENT_ESLINT_RANGE),
  );
  const fallback = reachesCurrent
    ? requirement.find((candidate) =>
        admitsAll(candidate, [CURRENT_ESLINT_RANGE]),
      )
    : requirement.find((candidate) => overlapsAll(candidate, declaredRanges));
  return (fallback ?? requirement[0]).install;
}

/** The readout for a covered framework, naming each declared package that covers it once. */
function coveredReadout(
  entry: FrameworkLinters,
  declared: ReadonlyMap<string, string[]>,
): string {
  const present = new Set(
    entry.requires
      .flat()
      .map(({ name }) => name)
      .filter((name) => declared.has(name)),
  );
  return `accessibility: ${entry.framework} + ${[...present].join(', ')}`;
}

/** The warning for a framework with unmet requirements, naming only what is missing. */
function missingLinterFinding(
  entry: FrameworkLinters,
  missing: readonly Requirement[],
  eslintRanges: readonly string[],
): Finding {
  const install = missing
    .map((requirement) => hintFor(requirement, eslintRanges))
    .join(' and ');
  return {
    level: 'WARN',
    msg: `accessibility: this repo uses ${entry.framework} but has no accessibility linter. Install ${install}. The accessibility rule is guidance and does not check markup mechanically.`,
  };
}

/**
 * Warns when a repo has a markup framework and no accessibility linter for it.
 *
 * This is where the plugin's central decision becomes visible to someone who never read the
 * README: houserules routes and reasons, the linter checks. A repo with neither is relying on the
 * agent to catch by hand what a linter catches mechanically.
 *
 * The install hint names only the missing requirements, at a version whose `eslint` peer range
 * admits the `eslint` the repo declares.
 *
 * Pure and read-only, per the `check` contract. A missing manifest, a `dependencies` field that
 * is not an object, a workspace package with no package.json, and an `eslint` range that is not
 * semver all return cleanly rather than throwing, because a doctor check that throws takes the
 * whole report down with it.
 */
export function checkAccessibilityLinter(ctx: Ctx): CheckResult {
  const declared = declaredDependencies(ctx);
  const eslintRanges = declaredEslintRanges(declared.get('eslint') ?? []);
  const findings: Finding[] = [];
  const readouts: string[] = [];

  for (const entry of LINTERS_BY_FRAMEWORK) {
    const usesFramework = entry.dependencies.some((name) => declared.has(name));
    if (!usesFramework) continue;

    const missing = entry.requires.filter(
      (requirement) => !requirement.some(({ name }) => declared.has(name)),
    );
    if (missing.length === 0) {
      readouts.push(coveredReadout(entry, declared));
    } else {
      findings.push(missingLinterFinding(entry, missing, eslintRanges));
    }
  }

  if (findings.length === 0 && readouts.length === 0) {
    readouts.push('accessibility: no markup framework detected');
  }
  return { findings, readouts };
}
