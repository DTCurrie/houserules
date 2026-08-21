import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      // Symlinks this package's own Tailwind dev dependencies into a synthetic repo, so it
      // stays here rather than in the published test package. Must come before the general
      // #test/* entry below, since vite resolves aliases in order.
      {
        find: '#test/tailwind-fixture',
        replacement: `${fileURLToPath(new URL('./test/tailwind-fixture.ts', import.meta.url))}`,
      },
      {
        find: /^#test\/(.*)$/,
        replacement: '@houserules/test/$1',
      },
    ],
  },
  test: {
    environment: 'node',
    include: [
      'src/**/__tests__/**/*.test.ts',
      'payload/**/__tests__/**/*.test.ts',
    ],
    globalSetup: ['@houserules/test/global-setup'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    expect: { requireAssertions: true },
  },
});
