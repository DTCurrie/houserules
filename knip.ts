import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  // `includeEntryExports` is deliberately not set. `verify:knip:audit` passes the flag by hand
  // instead, because every `entry` below exists for a reason knip cannot see.
  workspaces: {
    '.': {
      // The research scripts resolve the host's turndown from the working directory, which
      // is the repo root when an agent runs them here. knip cannot see a `createRequire` load.
      ignoreDependencies: ['turndown'],
      entry: [
        // Dev-facing probe documented in CLAUDE.md, invoked by hand as
        // `node scripts/probe-plugin.mjs <pkg>`. Nothing in the workspace imports it.
        'scripts/probe-plugin.mjs',
        // The health-pass audit kit, documented in scripts/health-kit/README.md and invoked
        // by hand as `node scripts/health-kit/<script>.mjs`. Nothing in the workspace
        // imports it.
        'scripts/health-kit/**/*.mjs',
        // The benchmark harness, documented in scripts/bench/README.md and invoked by hand as
        // `node scripts/bench/run.mjs`. Nothing in the workspace imports it.
        'scripts/bench/run.mjs',
        // Field extractors, piped over ssh to another machine as single self-contained files.
        // Nothing in the workspace imports them.
        'scripts/bench/field-stop-runs.mjs',
        'scripts/bench/field-repro.mjs',
        'scripts/bench/verify-jobs.mjs',
        // The paid behavioral check, documented in scripts/eval/README.md and invoked by hand as
        // `node scripts/eval/run.mjs`. Nothing in the workspace imports it.
        'scripts/eval/run.mjs',
        // The bench and eval suites, run by `test:scripts` as files of their own. Its command
        // names three globs, and knip reads only the first as test entries.
        'scripts/bench/__tests__/*.test.mjs',
        'scripts/eval/__tests__/*.test.mjs',
      ],
      // The eval's fixture repo, copied into a scratch directory for each paid session and never
      // imported from this workspace.
      ignore: ['scripts/eval/fixtures/**'],
    },
    'packages/cli': {
      entry: [
        'bin/*.mjs',
        // A custom `entry` array replaces knip's defaults rather than extending them. Without
        // this restatement, every command reached only through cli.ts's dynamic `import()`
        // dispatch reports as unused.
        'src/cli.ts',
        // Reached only through bin/houserules-payload.mjs, which imports the built
        // dist/payload-build-bin.js. knip's graph is source-only and cannot follow that edge.
        'src/payload-build-bin.ts',
        // The plugin-author public API. Its importers are third-party plugin packages, none of
        // which live in this workspace, so all 26 re-exported symbols read as unused.
        'src/plugin.ts',
        // Compiled to payload-dist/ and copied into a user's .claude/scripts/, where hooks and
        // skills invoke them by path, never by import. See CLAUDE.md's payload/ section.
        'payload/scripts/**/*.mts',
        // The built-in modules from src/plan.ts's `MODULES`. plan.ts consumes each as a
        // namespace object satisfying `ModuleDef`, so knip sees the namespace used but not the
        // named exports inside it.
        'src/modules/ci-settings.ts',
        'src/modules/code-cleanliness.ts',
        'src/modules/core.ts',
        'src/modules/debug-session.ts',
        'src/modules/lint-fix.ts',
        'src/modules/orchestrate.ts',
        'src/modules/plans.ts',
        'src/modules/read-guard.ts',
        'src/modules/ready.ts',
        'src/modules/regen.ts',
        'src/modules/rename.ts',
        'src/modules/research.ts',
        'src/modules/reviewers.ts',
        'src/modules/session-context.ts',
        'src/modules/statusline.ts',
        'src/modules/sweep.ts',
        'src/modules/tool-output-trim.ts',
        'src/modules/verify-changed.ts',
      ],
      // The HOST's own turndown, resolved at runtime by payload/scripts/fetch-batch.mts through
      // `createRequire`, the way plugin-design reaches the host's Tailwind. knip cannot see it.
      ignoreDependencies: ['turndown'],
    },
    'packages/cli/test/plugin-fixture': {
      // Loaded by the plugin resolver under test through paths built at test time, and the
      // `libs` fixture is deliberately unresolvable as source. Excluded rather than declared.
      ignore: ['**/*'],
    },
    'packages/payload': {
      // The six shared payload libs. Every consumer is in another package's payload/ and
      // reaches them by package name, so nothing in this workspace imports the sources.
      entry: ['payload/scripts/lib/*.mts'],
    },
    // Each plugin's payload scripts import `@houserules/payload/<lib>` by package name.
    // Declaring those scripts as entries is what lets knip see that edge, so no
    // dependency-level exemption is needed.
    'packages/plugin-accessibility': {
      entry: ['src/index.ts', 'payload/scripts/**/*.mts'],
    },
    'packages/plugin-backlog': {
      entry: ['src/index.ts', 'payload/scripts/**/*.mts'],
    },
    'packages/plugin-changesets': {
      entry: ['src/index.ts', 'payload/scripts/**/*.mts'],
    },
    'packages/plugin-decisions': {
      entry: ['src/index.ts', 'payload/scripts/**/*.mts'],
    },
    'packages/plugin-design': {
      entry: ['src/index.ts', 'payload/scripts/**/*.mts'],
      // The HOST's own Tailwind, loaded through a fully dynamic `import()` of a path resolved
      // at runtime by payload/scripts/lib/tailwind-host-packages.mts. knip cannot see it.
      ignoreDependencies: ['@tailwindcss/oxide', 'tailwindcss'],
    },
    'packages/api': {
      // Two published entry points, both declared in this package's `exports` map. knip infers
      // neither, so internal.ts and everything it re-exports read as unused without them.
      entry: ['src/index.ts', 'src/internal.ts'],
    },
    'packages/plugin-github': {
      entry: ['src/index.ts', 'payload/scripts/**/*.mts'],
    },
    'packages/plugin-prose': {
      entry: ['src/index.ts', 'payload/scripts/**/*.mts'],
    },
    'packages/plugin-svelte': {
      entry: ['src/index.ts', 'payload/scripts/**/*.mts'],
    },
    'packages/plugin-testing': {
      entry: ['src/index.ts', 'payload/scripts/**/*.mts'],
    },
  },
};

export default config;
