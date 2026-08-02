import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      // Colocated suites live up to three directories deep, so a relative path to the shared
      // testing modules reads as `../../../test/repo.js`. A prefix alias rather than one
      // entry per module, so adding a module needs no config change. Kept out of package.json
      // `imports`, which would publish a mapping pointing at files the package does not ship.
      {
        find: /^#test\/(.*)$/,
        replacement: `${fileURLToPath(new URL('./test/', import.meta.url))}$1.ts`,
      },
    ],
  },
  test: {
    environment: 'node',
    // The root __test__/ holds only shared fixtures and global setup, never a test. Every
    // test lives beside the unit it covers.
    include: [
      'src/**/__test__/**/*.test.ts',
      'payload/**/__test__/**/*.test.ts',
    ],
    globalSetup: ['test/global-setup.ts'],
    // Several suites shell out to the CLI against mkdtemp fixtures; the default
    // 5s timeout is not enough for an end-to-end init + update + doctor chain.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    expect: { requireAssertions: true },
  },
});
