import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  // `includeEntryExports` is deliberately not set. `verify:knip:audit` passes the flag by hand
  // instead, because every `entry` below exists for a reason knip cannot see. See AGENTKIT-025dda.
  workspaces: {
    '.': {
      // Dev-facing scripts invoked by hand, never imported. `probe-plugin.mjs` is documented
      // in CLAUDE.md. `bootstrap-publish.mjs` is the one-off that puts each package on the
      // registry so a trusted publisher can be configured for it.
      entry: ['scripts/probe-plugin.mjs', 'scripts/bootstrap-publish.mjs'],
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
        'src/modules/reviewers.ts',
        'src/modules/session-context.ts',
        'src/modules/statusline.ts',
        'src/modules/sweep.ts',
        'src/modules/verify-changed.ts',
      ],
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
