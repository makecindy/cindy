import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function fileDigest(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Include sorted paths as well as contents, so removals and preserved mtimes invalidate. */
export function bundleInputDigest(pkgDir, dependencyDirs = []) {
  const inputs = [];
  function visit(root, rel, prefix) {
    const abs = join(root, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) {
      for (const name of readdirSync(abs).sort()) visit(root, join(rel, name), prefix);
    } else {
      inputs.push([prefix, rel.replaceAll('\\', '/'), fileDigest(abs)]);
    }
  }
  for (const rel of ['src', 'build.mjs', 'package.json']) visit(pkgDir, rel, 'package');
  dependencyDirs.forEach((dependency, index) => {
    if (!existsSync(dependency)) throw new Error(`Remote bundle source dependency is missing: ${dependency}`);
    for (const rel of ['src', 'package.json', 'LICENSE.opencodex']) visit(dependency, rel, `dependency:${index}`);
  });
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}

export function bundleInputsMatch(bundle, inputDigest) {
  if (!existsSync(bundle)) return false;
  try {
    const receipt = JSON.parse(readFileSync(`${bundle}.inputs.json`, 'utf8'));
    return receipt?.version === 1 && receipt.inputDigest === inputDigest && receipt.outputDigest === fileDigest(bundle);
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return false;
    throw error;
  }
}

/** Called only after a successful build; failed builds never bless stale output. */
export function recordBundleInputs(bundle, inputDigest) {
  writeFileSync(`${bundle}.inputs.json`, JSON.stringify({ version: 1, inputDigest, outputDigest: fileDigest(bundle) }) + '\n');
}
