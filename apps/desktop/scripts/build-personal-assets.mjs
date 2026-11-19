// Run only in the unused candidate checkout. Use the package build of the same
// Forge Vite plugin as releases (all main, preload and renderer entries).
import { createRequire } from 'node:module';
import { createJiti } from 'jiti';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Listr } from 'listr2';

const desktop = fileURLToPath(new URL('../', import.meta.url));
process.chdir(desktop);
const require = createRequire(import.meta.url);
const { VitePlugin } = require('@electron-forge/plugin-vite');
const config = await createJiti(import.meta.url).import(path.resolve(desktop, 'forge.config.ts'), { default: true });
const plugin = config.plugins.find(p => p instanceof VitePlugin || p.name === 'vite');
if (!plugin) throw Error('Missing Forge Vite configuration');
plugin.init(desktop);
const hooks = plugin.getHooks().prePackage;
await new Listr(hooks.map(hook => ({
  title: 'Build personal desktop assets',
  task: (_ctx, task) => hook.call(task, config, process.platform, process.arch),
})), {renderer:'append-only'}).run();
