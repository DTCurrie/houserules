import type { CheckResult, Ctx, Finding } from '@agent-kit/cli/plugin';

/**
 * A markup framework, and the accessibility linter a repo using it should have. The plugin
 * ships routing and reasoning. The mechanical checking belongs to these, and every one of them
 * is better at it than anything the kit would write.
 */
const LINTERS_BY_FRAMEWORK = [
  {
    framework: 'react',
    dependencies: ['react', 'next', 'preact'],
    linters: ['eslint-plugin-jsx-a11y'],
    install: 'eslint-plugin-jsx-a11y',
  },
  {
    framework: 'vue',
    dependencies: ['vue', 'nuxt'],
    linters: ['eslint-plugin-vuejs-accessibility'],
    install: 'eslint-plugin-vuejs-accessibility',
  },
  {
    framework: 'svelte',
    dependencies: ['svelte'],
    // Svelte checks accessibility in the compiler, so the tool to have is the one that
    // surfaces those warnings outside the dev server rather than a separate lint plugin.
    linters: ['svelte-check'],
    install: 'svelte-check',
  },
  {
    framework: 'astro',
    dependencies: ['astro'],
    linters: ['eslint-plugin-jsx-a11y', 'astro-eslint-parser'],
    install: 'eslint-plugin-jsx-a11y',
  },
] as const;

/** Every dependency name declared anywhere in the repo, root and workspace packages alike. */
function declaredDependencies(ctx: Ctx): Set<string> {
  const names = new Set<string>();
  const manifests = [ctx.rootPkg, ...ctx.packages.map((entry) => entry.pkg)];
  for (const manifest of manifests) {
    if (!manifest || typeof manifest !== 'object') continue;
    for (const field of ['dependencies', 'devDependencies'] as const) {
      const bag = manifest[field];
      if (!bag || typeof bag !== 'object') continue;
      for (const name of Object.keys(bag)) names.add(name);
    }
  }
  return names;
}

/**
 * Warns when a repo has a markup framework and no accessibility linter for it.
 *
 * This is where the plugin's central decision becomes visible to someone who never read the
 * README: the kit routes and reasons, the linter checks. A repo with neither is relying on the
 * agent to catch by hand what a linter catches mechanically.
 *
 * Pure and read-only, per the `check` contract. A missing manifest, a `dependencies` field that
 * is not an object, and a workspace package with no package.json all return cleanly rather than
 * throwing, because a doctor check that throws takes the whole report down with it.
 */
export function checkAccessibilityLinter(ctx: Ctx): CheckResult {
  const declared = declaredDependencies(ctx);
  const findings: Finding[] = [];
  const readouts: string[] = [];

  for (const entry of LINTERS_BY_FRAMEWORK) {
    const usesFramework = entry.dependencies.some((name) => declared.has(name));
    if (!usesFramework) continue;

    const present = entry.linters.filter((name) => declared.has(name));
    if (present.length > 0) {
      readouts.push(
        `accessibility: ${entry.framework} + ${present.join(', ')}`,
      );
      continue;
    }
    findings.push({
      level: 'WARN',
      msg: `accessibility: this repo uses ${entry.framework} but has no accessibility linter — install ${entry.install}. The accessibility rule is guidance and does not check markup mechanically.`,
    });
  }

  if (findings.length === 0 && readouts.length === 0) {
    readouts.push('accessibility: no markup framework detected');
  }
  return { findings, readouts };
}
