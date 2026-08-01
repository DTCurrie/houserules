import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Several suites shell out to the CLI against mkdtemp fixtures; the default
    // 5s timeout is not enough for an end-to-end init + update + doctor chain.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    expect: { requireAssertions: true },
  },
});
