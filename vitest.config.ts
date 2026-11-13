import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
    environment: 'node',
    server: {
      deps: {
        // node:sqlite 是 Node 内置模块，不能被 vite 打包处理
        external: [/^node:/],
      },
    },
  },
});
