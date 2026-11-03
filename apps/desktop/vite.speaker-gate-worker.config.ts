import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    conditions: ['node'],
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
  build: {
    rollupOptions: {
      // Native addon, loaded at runtime from the unpacked node_modules.
      external: ['sherpa-onnx-node'],
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
