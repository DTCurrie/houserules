import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  workspaces: {
    '.': {
      // Manual dev-facing probe documented in CLAUDE.md's 'Rules' section, invoked by
      // hand as `node scripts/probe-plugin.mjs <pkg>`. Nothing in the workspace imports
      // it.
      entry: ['scripts/probe-plugin.mjs'],
    },
    'packages/cli': {
      entry: [
        'bin/*.mjs',
        // The CLI's own entry point, resolved automatically by knip's defaults when no
        // workspace `entry` is configured. Declaring a custom `entry` array below for the
        // three payload/bin cases replaces those defaults rather than extending them, so
        // this has to be restated here or every command reached only through cli.ts's
        // dynamic `import()` dispatch (init, modules, update, doctor, probe, report)
        // reports as unused.
        'src/cli.ts',
        // Compiled to dist/ and invoked by bin/agent-kit-payload.mjs, which imports the
        // built dist/payload-build-bin.js rather than this source file (see that bin
        // file's own comment on why `bin` cannot point straight at dist/). knip's graph
        // is source-only, so it cannot trace that edge without this entry.
        'src/payload-build-bin.ts',
        // The deliberate plugin-author public API CLAUDE.md documents under 'Rules':
        // third-party plugin packages are the importers of its re-exported types, and
        // none of them live in this workspace, so knip has no in-repo importer to find
        // and flags all 26 re-exported symbols as unused. Declaring the file itself an
        // entry stops knip reporting its own exports as unused.
        'src/plugin.ts',
        // Claude Code hook and CLI scripts: compiled to payload-dist/ and copied into a
        // user's .claude/scripts/, where hooks and skills invoke them by path, never by
        // import. See CLAUDE.md's payload/ section.
        'payload/scripts/**/*.mts',
        // The sixteen built-in modules (CLAUDE.md's `MODULES` array in src/plan.ts).
        // Each is authored as a set of named exports (id, title, group, hint,
        // defaultEnabled, plan, ...) rather than one object, and plan.ts consumes the
        // whole file as `import * as core from './modules/core.js'`, passing that
        // namespace object around generically as a `ModuleDef`. knip can see the
        // namespace is used, but not that each individual named export inside it is
        // the property access satisfying `ModuleDef`, so every member reports unused
        // without this.
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
      // This fixture tree (see its own comment in pnpm-workspace.yaml) is staged into a
      // temp repo and its packages are loaded by the plugin resolver under test through
      // the real Node resolver, using paths built from strings at test time. Some of it
      // (the `libs` fixture) even models the agent-kit-payload build rewrite by
      // importing a relative `./lib/*.mjs` path that only exists once the resolver copies
      // it there, so it is deliberately unresolvable as source. None of it is a real
      // production entry point or a real dependency graph, so the whole tree is excluded
      // rather than declared as entries.
      ignore: ['**/*'],
    },
    'packages/payload': {
      // The six shared payload libs CLAUDE.md's 'Payload code crosses packages by
      // PACKAGE NAME' rule describes. Every consumer is in another package's payload/,
      // importing via a `@agent-kit/payload/<lib>` specifier that the agent-kit-payload
      // bin only rewrites to a relative path in the EMITTED .mjs, not in this source.
      // Nothing in this workspace imports them directly, so without an entry they are
      // unreachable from anything knip's graph starts at.
      entry: ['payload/scripts/lib/*.mts'],
    },
    // Each of these six consumes `@agent-kit/payload/<lib>` (where applicable) from its
    // own payload scripts, at the source level, as an ordinary package-name import that
    // pnpm's workspace symlink and the package's `exports` map resolve like any other
    // dependency. Declaring those scripts as entries is what lets knip see the edge; no
    // dependency-level exemption is needed once it can. `src/index.ts` is restated for
    // the same reason `packages/cli` restates `src/cli.ts`: a custom `entry` array
    // replaces knip's default package.json-`main`-driven detection rather than
    // extending it.
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
      // @tailwindcss/oxide and tailwindcss are the HOST's own Tailwind, resolved at
      // runtime via a fully dynamic `import(resolved.value.entryModuleUrl)` built from a
      // path knip cannot see statically (payload/scripts/lib/tailwind-host-packages.mts
      // and its two callers). The design-tailwind project decided to wrap the host's
      // Tailwind rather than reimplement it, which is why this can never be a static
      // import.
      ignoreDependencies: ['@tailwindcss/oxide', 'tailwindcss'],
    },
    'packages/api': {
      // Two published entry points, both declared in this package's `exports` map. `.` is
      // the plugin contract a third-party author codes against, and `./internal` is what the
      // installer reaches across the package boundary. knip infers neither, so without both
      // named here `internal.ts` reads as an unused file and everything it re-exports reads
      // as an unused export.
      entry: ['src/index.ts', 'src/internal.ts'],
    },
    'packages/plugin-github': {
      entry: ['src/index.ts', 'payload/scripts/**/*.mts'],
    },
  },
};

export default config;
