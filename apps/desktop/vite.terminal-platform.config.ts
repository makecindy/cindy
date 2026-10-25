import path from 'node:path';
import { defineConfig } from 'vite';
import { buildDesktopPlatformMain } from '../cindy-terminal/scripts/desktop-platform-build.mjs';

const entry = path.resolve(__dirname, 'src/main/terminal-platform-entry.ts');

// Preserve Forge's original native packaging, capture renderer and sealed ASAR.
// Bundle Main once with the terminal bundler, avoiding a second whole-app graph.
export default defineConfig({
  plugins: [{
    name: 'terminal-main-asset',
    load(id) { if (path.resolve(id) === entry) return 'export {};'; },
    async generateBundle() {
      const result = await buildDesktopPlatformMain(path.resolve(__dirname, '.vite/build/terminal-platform-main.mjs'), false);
      for (const file of result.outputFiles)
        this.emitFile({ type: 'asset', fileName: path.basename(file.path), source: file.contents });
    },
  }],
  build: {
    target: 'node22', minify: false,
    lib: { entry, formats: ['es'], fileName: () => 'terminal-platform-forge.mjs' },
    rollupOptions: { output: { format: 'es', entryFileNames: 'terminal-platform-forge.mjs' } },
  },
});
