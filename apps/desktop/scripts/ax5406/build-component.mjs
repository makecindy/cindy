import { build } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from 'tailwindcss';
import loadTailwindConfig from 'tailwindcss/loadConfig.js';
import autoprefixer from 'autoprefixer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export async function buildComponent(output, source = 'worktree') {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const desktop = path.resolve(root, '../..');
  const inputs = {};
  const overrides = new Map();
  if (source === 'head') {
    for (const file of ['src/renderer/components/chat/MessageStream.tsx', 'src/renderer/styles/globals.css']) {
      overrides.set(path.join(desktop, file).replaceAll('\\', '/'),
        execFileSync('git', ['show', `HEAD:apps/desktop/${file}`], { cwd: desktop, encoding: 'utf8' }));
    }
  }
  const tailwindConfig = loadTailwindConfig(path.join(desktop, 'tailwind.config.ts'));
  tailwindConfig.content = [path.join(desktop, 'src/renderer/**/*.{ts,tsx,html}').replaceAll('\\', '/')];
  await build({ configFile: false, root, base: './', publicDir: false, logLevel: 'warn',
    plugins: [{ name: 'read-only-head-comparison', enforce: 'pre', load(id) {
      return overrides.get(id.replaceAll('\\', '/'));
    } }, react(), { name: 'record-real-source', async transform(code, id) {
      if (id.replaceAll('\\', '/').includes('/src/renderer/') && !id.includes('?')) inputs[path.relative(desktop, id)] = createHash('sha256').update(overrides.get(id.replaceAll('\\', '/')) ?? await fs.readFile(id)).digest('hex');
    } }],
    resolve: { alias: { '@': path.join(desktop, 'src/renderer') } },
    css: { postcss: { plugins: [tailwind(tailwindConfig), autoprefixer()] } },
    build: { target: 'chrome146', outDir: path.join(output, 'component'), emptyOutDir: false,
      minify: false, sourcemap: true, rollupOptions: { input: path.join(root, 'component.html') } },
  });
  await fs.writeFile(path.join(output, 'component-sources.json'), JSON.stringify(inputs, null, 2));
  return path.join(output, 'component/component.html');
}
