import path from 'node:path';

/**
 * Whether a dependency copy would be redundant in a standalone Host release.
 *
 * Node resolves a bare specifier by walking up from the importing package's
 * directory through each enclosing `node_modules`. If the nearest enclosing copy
 * of `name` is the same `source`, the import already resolves to it and nesting
 * another identical copy only adds files. A different version in between shadows
 * the outer copy, so the dependency must still be copied locally.
 *
 * @param {Map<string, string>} copies release destination -> source package dir
 * @param {{ root: string, parent: string, name: string, source: string }} input
 *   `parent` is the package directory whose `node_modules` would receive the copy.
 */
export function resolvesToExistingCopy(copies, { root, parent, name, source }) {
  for (let dir = path.dirname(parent); dir === root || dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
    // copyPackage only creates node_modules inside package roots, never directly
    // under a `node_modules` or `@scope` directory, so there is nothing to find.
    const base = path.basename(dir);
    if (base !== 'node_modules' && !base.startsWith('@')) {
      const candidate = path.join(dir, 'node_modules', name);
      if (copies.has(candidate)) return copies.get(candidate) === source;
    }
    if (dir === root) break;
  }
  return false;
}
