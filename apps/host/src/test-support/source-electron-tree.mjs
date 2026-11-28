import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Run the actual Host source with a private Desktop dependency tree. Other
// workspace packages stay at their usual versions; no installed files change.
export function createSourceElectronTree(root) {
  const repo = fileURLToPath(new URL('../../../../', import.meta.url));
  const host = path.join(root, 'apps', 'host');
  const desktop = path.join(root, 'apps', 'desktop');
  const electron = path.join(desktop, 'node_modules', 'electron');
  fs.mkdirSync(path.join(host, 'node_modules'), { recursive: true });
  fs.mkdirSync(electron, { recursive: true });
  for (const file of ['package.json', 'apps/host/package.json', 'apps/host/tsconfig.json',
    'apps/desktop/package.json', 'apps/desktop/tsconfig.json']) {
    fs.copyFileSync(path.join(repo, file), path.join(root, file));
  }
  fs.cpSync(path.join(repo, 'apps/host/src'), path.join(host, 'src'), { recursive: true });
  for (const dir of ['node_modules', 'packages', 'config', 'apps/desktop/src', 'apps/desktop/resources']) {
    fs.symlinkSync(path.join(repo, dir), path.join(root, dir), 'junction');
  }
  fs.symlinkSync(electron, path.join(host, 'node_modules', 'electron'), 'junction');
  for (const app of ['host', 'desktop']) {
    const deps = path.join('apps', app, 'node_modules');
    if (!fs.existsSync(path.join(repo, deps))) continue;
    for (const name of fs.readdirSync(path.join(repo, deps))) {
      if (name !== 'electron' && !name.startsWith('.')) {
        fs.symlinkSync(path.join(repo, deps, name), path.join(root, deps, name), 'junction');
      }
    }
  }
  fs.writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ name: 'electron', main: 'index.cjs' }));
  // Stand in for the npm entry's synchronous installer without using a network
  // or installation program, even if a regression reaches it.
  fs.writeFileSync(path.join(electron, 'index.cjs'), `
    require('node:fs').writeFileSync(require('node:path').join(__dirname, 'entry-ran'), '');
    require('node:child_process').spawnSync(process.execPath, ['-e', '']);
    throw new Error('synthetic Electron installer');
  `);
  return { host, electron };
}
