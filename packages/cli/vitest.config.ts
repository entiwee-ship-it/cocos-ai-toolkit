import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@cocos-ai/client': fileURLToPath(new URL('../client/src/index.ts', import.meta.url)),
      '@cocos-ai/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@cocos-ai/protocol': fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url))
    }
  },
  test: {
    include: ['tests/**/*.test.ts']
  }
});
