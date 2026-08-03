import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    conditions: ['node'],
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
  build: {
    rollupOptions: {
      // sharp 是原生 N-API 模块，随 packaged app 的 runtime deps 按平台解析。
      external: ['sharp'],
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
