import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    conditions: ['node'],
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
  build: {
    rollupOptions: {
      // Keep the native canvas binding as a packaged runtime dependency. Trying
      // to CommonJS-transform it makes Forge silently omit this utility entry.
      external: ['@napi-rs/canvas'],
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
