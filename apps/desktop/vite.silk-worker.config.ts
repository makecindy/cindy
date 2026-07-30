import { defineConfig } from 'vite';

export default defineConfig({
  ssr: {
    noExternal: ['silk-wasm'],
  },
  resolve: {
    conditions: ['node'],
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
  build: {
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
