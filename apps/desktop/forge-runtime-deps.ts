import * as fs from 'node:fs';
import * as path from 'node:path';

type ResolvePackage = (name: string, fromDirs?: string[]) => string;

/** Copy runtime closures, reusing only the exact source package visible to Node. */
export function copyRuntimeDependencyTrees(
  deps: readonly string[],
  destModules: string,
  resolvePackage: ResolvePackage,
): void {
  function copyLevel(
    names: readonly string[],
    destination: string,
    ancestors: ReadonlyMap<string, string>[],
    fromDirs?: string[],
  ): void {
    const local = new Map<string, string>();
    // Reserve all siblings before descending: Node can resolve a sibling even
    // when it is copied later. The nearest version wins, just as in Node.
    for (const name of names) {
      const source = fs.realpathSync(resolvePackage(name, fromDirs));
      const visible = ancestors.find((level) => level.has(name))?.get(name);
      if (visible !== source) local.set(name, source);
    }
    for (const [name, source] of local) {
      const target = path.join(destination, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.rmSync(target, { recursive: true, force: true });
      fs.cpSync(source, target, {
        recursive: true,
        dereference: true,
        filter: (file) => path.basename(file) !== 'node_modules',
      });
      const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      copyLevel(
        Object.keys(manifest.dependencies ?? {}).sort(),
        path.join(target, 'node_modules'),
        [local, ...ancestors],
        [source],
      );
    }
  }
  copyLevel(deps, destModules, []);
}
