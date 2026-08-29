import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@cocos-ai/client': fileURLToPath(new URL('../client/src/index.ts', import.meta.url)),
      '@cocos-ai/protocol': fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url))
    }
  },
  test: {
    include: ['tests/**/*.test.ts']
  }
});
