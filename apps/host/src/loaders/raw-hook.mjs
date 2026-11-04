/**
 * Resolve Vite-style `?raw` asset imports for Node.
 *
 * maker-core's agents import prompt files as `./x.md?raw`; Node has no notion of
 * query specifiers. This hook turns them into a module whose default export is
 * the file's text, so the host can load the real agent classes from source
 * without a bundler (the migration runner needs real `.ts` require at runtime).
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  const wantsRaw = specifier.endsWith('?raw');
  if (!wantsRaw && !specifier.endsWith('.md')) return nextResolve(specifier, context);
  const bare = wantsRaw ? specifier.slice(0, -'?raw'.length) : specifier;
  const target = new URL(bare, context.parentURL);
  if (target.protocol !== 'file:') return nextResolve(specifier, context);
  return { url: `cindy-raw:${fileURLToPath(target)}`, shortCircuit: true };
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith('cindy-raw:')) return nextLoad(url, context);
  const filesystemPath = url.slice('cindy-raw:'.length).replace(/\?raw$/, '');
  const text = await readFile(filesystemPath, 'utf8');
  return {
    format: 'module',
    shortCircuit: true,
    source: `export default ${JSON.stringify(text)};`,
  };
}

void pathToFileURL;
