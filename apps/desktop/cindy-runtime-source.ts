import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import type { RuntimeSourceBuild } from './src/main/cindy-make/runtimeVersion';

export function captureRuntimeSource(
  root: string,
  development: boolean,
  deps = {
    git: (args: string[]) =>
      execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        timeout: 3000,
        maxBuffer: 256 * 1024,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    readPackage: () => readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8'),
  },
): RuntimeSourceBuild {
  try {
    const commit = deps.git(['rev-parse', 'HEAD']).trim();
    if (!/^[a-f0-9]{40}$/.test(commit)) return {};
    const status = deps.git(['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
    let dirty = status.length > 0;
    if (!development && status === ' M apps/desktop/package.json\0') {
      const original = JSON.parse(deps.git(['show', 'HEAD:apps/desktop/package.json']));
      const packaged = JSON.parse(deps.readPackage());
      delete original.version;
      delete packaged.version;
      dirty = JSON.stringify(original) !== JSON.stringify(packaged);
    }
    if (deps.git(['rev-parse', 'HEAD']).trim() !== commit) return {};
    return { commit, dirty, ...(development ? { root } : {}) };
  } catch {
    return {};
  }
}

export function cindyRuntimeSourcePlugin(
  root: string,
  development: boolean,
  capture = () => captureRuntimeSource(root, development),
): Plugin {
  const matches = (id: string) =>
    id.replaceAll('\\', '/').endsWith('/cindy-make/runtimeVersion.ts');
  return {
    name: 'cindy-runtime-source',
    enforce: 'pre',
    shouldTransformCachedModule({ id }) {
      return matches(id) ? true : undefined;
    },
    transform(source, id) {
      if (!matches(id)) return;
      return {
        code: source.replaceAll('import.meta.env.CINDY_RUNTIME_SOURCE', JSON.stringify(capture())),
        map: null,
      };
    },
  };
}
