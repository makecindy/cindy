import path from 'node:path';

/**
 * Nested dependency copies in a standalone Host release that Node would never load.
 *
 * Node resolves a bare specifier by walking up from the importing package's
 * directory through each enclosing `node_modules`. A copy is redundant when the
 * nearest enclosing copy of the same package name is the same source: removing it
 * makes every importer that found it continue upward to that identical copy, so
 * each import still resolves to the same package. A different version in between
 * shadows the outer copy and keeps this one.
 *
 * Decided on the complete layout, after every copy is placed: deciding while the
 * tree is still being copied misses a different version written later in between.
 *
 * @param {Map<string, string>} copies release destination dir -> source package dir
 * @param {string} root release root; nothing outside it is considered
 * @returns {string[]} destinations to remove, shallowest first
 */
export function redundantCopies(copies, root) {
  const redundant = [];
  for (const [destination, source] of copies) {
    const parts = destination.split(path.sep);
    const at = parts.lastIndexOf('node_modules');
    if (at < 0) continue;
    const name = parts.slice(at + 1).join('/');
    const parent = parts.slice(0, at).join(path.sep);
    for (let dir = path.dirname(parent); dir === root || dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
      // The release only creates node_modules inside package roots, never directly
      // under a `node_modules` or `@scope` directory, so there is nothing to find.
      const base = path.basename(dir);
      if (base !== 'node_modules' && !base.startsWith('@')) {
        const candidate = path.join(dir, 'node_modules', ...name.split('/'));
        if (copies.has(candidate)) {
          if (copies.get(candidate) === source) redundant.push(destination);
          break;
        }
      }
      if (dir === root) break;
    }
  }
  return redundant.sort((a, b) => a.length - b.length);
}
