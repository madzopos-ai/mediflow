import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The route tests bind real sockets (ephemeral ports), so they must not
    // share a worker with the rest of the suite in a way that races on PORT.
    pool: 'forks',
    include: ['test/**/*.test.ts'],
    testTimeout: 15_000,
  },
});
