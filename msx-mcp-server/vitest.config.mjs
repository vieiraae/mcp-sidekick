import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.{js,mjs}'],
    setupFiles: ['./src/__tests__/_setup.mjs'],
    testTimeout: 15000
  }
});
