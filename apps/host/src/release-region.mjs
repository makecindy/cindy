import fs from 'node:fs';
import path from 'node:path';

/**
 * A Host release is built for one edition, as the desktop is (region-and-editions.md §2.4: the
 * installed build decides the region). The edition is fixed when the release is built and cannot be
 * changed at startup.
 */
export const RELEASE_REGIONS = Object.freeze(['cn', 'global']);

/**
 * The release builder's region. There is no default: a missing or unknown value fails the build
 * rather than producing a package of the wrong edition (the fail-closed exception of §2.2, as the
 * desktop's versioned packaging requires `--region`).
 *
 * @param {string | undefined} value
 * @returns {'cn' | 'global'}
 */
export function selectReleaseRegion(value) {
  if (value === 'cn' || value === 'global') return value;
  throw new Error(`A Host release needs --region cn or --region global; received ${value === undefined ? 'none' : JSON.stringify(value)}`);
}

// The desktop renderer reads its region as `import.meta.env?.VITE_CINDY_AUTH_REGION`
// (shared/brandRegion.ts); for that optional access Vite inlines the whole env object, so every renderer
// build carries one `VITE_CINDY_AUTH_REGION:"<region>"`.
const WEB_REGION_MARKER = /VITE_CINDY_AUTH_REGION:"([a-z]+)"/g;

function scriptFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...scriptFiles(file));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(file);
  }
  return files;
}

/**
 * The regions a renderer build was built for, read from its scripts.
 *
 * @param {string} webDir
 * @returns {string[]} sorted, distinct
 */
export function readWebRegions(webDir) {
  const regions = new Set();
  for (const file of scriptFiles(webDir)) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(WEB_REGION_MARKER)) regions.add(match[1]);
  }
  return [...regions].sort();
}

/**
 * A release must serve the renderer of its own edition. A renderer whose region cannot be read, or that
 * carries another or more than one, is refused.
 *
 * @param {string} webDir
 * @param {'cn' | 'global'} region
 */
export function assertWebRegion(webDir, region) {
  const regions = readWebRegions(webDir);
  if (regions.length === 1 && regions[0] === region) return;
  throw new Error(regions.length === 0
    ? `Cannot read the region of the renderer build in ${webDir}; build it with VITE_CINDY_AUTH_REGION=${region}`
    : `The renderer build in ${webDir} is for ${regions.join(', ')}, not ${region}; build it with VITE_CINDY_AUTH_REGION=${region}`);
}
