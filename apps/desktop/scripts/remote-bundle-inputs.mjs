import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function newestMtime(rootDir, relPaths) {
  let newest = 0;
  for (const rel of relPaths) {
    const abs = join(rootDir, rel);
    if (!existsSync(abs)) continue;
    const st = statSync(abs);
    if (st.isDirectory()) {
      for (const entry of readdirSync(abs, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        newest = Math.max(newest, statSync(join(entry.parentPath ?? abs, entry.name)).mtimeMs);
      }
    } else newest = Math.max(newest, st.mtimeMs);
  }
  return newest;
}

/** A workspace dependency can change without touching the consuming package's source. */
export function newestBundleInputMtime(pkgDir, dependencyDirs = []) {
  let newest = newestMtime(pkgDir, ['src', 'build.mjs', 'package.json']);
  for (const dependency of dependencyDirs) {
    if (!existsSync(dependency)) throw new Error(`Remote bundle source dependency is missing: ${dependency}`);
    newest = Math.max(newest, newestMtime(dependency, ['src', 'package.json', 'LICENSE.opencodex']));
  }
  return newest;
}
