import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      // ctx-builder builds Ctx/Target/Answers/ModuleDef fixtures straight from this
      // package's own src/, so it stays here rather than in the published test. This
      // entry must come before the general #test/* one below, since vite resolves aliases
      // in order and the general entry would otherwise shadow it.
      {
        find: '#test/ctx-builder',
        replacement: `${fileURLToPath(new URL('./test/ctx-builder.ts', import.meta.url))}`,
      },
      // Colocated suites live up to three directories deep, so a relative path to the shared
      // testing modules reads as `../../../test/repo.js`. The `#test/*` alias reads the same
      // either way, but now resolves through @houserules/test, a published package, rather
      // than a relative path into this package's own `test/` directory. A prefix alias rather
      // than one entry per module, so adding a module needs no config change here, only an
      // export in that package.
      {
        find: /^#test\/(.*)$/,
        replacement: '@houserules/test/$1',
      },
    ],
  },
  test: {
    environment: 'node',
    // The root __tests__/ holds only shared fixtures and global setup, never a test. Every
    // test lives beside the unit it covers.
    include: [
      'src/**/__tests__/**/*.test.ts',
      'payload/**/__tests__/**/*.test.ts',
    ],
    globalSetup: ['@houserules/test/global-setup'],
    // Several suites shell out to the CLI against mkdtemp fixtures; the default
    // 5s timeout is not enough for an end-to-end init + update + doctor chain.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    expect: { requireAssertions: true },
  },
});
