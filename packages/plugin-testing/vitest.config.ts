import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^#test\/(.*)$/,
        replacement: '@houserules/test/$1',
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/**/__test__/**/*.test.ts'],
    globalSetup: ['@houserules/test/global-setup'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    expect: { requireAssertions: true },
  },
});
