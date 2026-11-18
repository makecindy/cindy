/**
 * Resolve Vite-style `?raw` asset imports for Node.
 *
 * maker-core's agents import prompt files as `./x.md?raw`; Node has no notion of
 * query specifiers. This hook turns them into a module whose default export is
 * the file's text, so the host can load the real agent classes from source
 * without a bundler (the migration runner needs real `.ts` require at runtime).
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { transform } from 'esbuild';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && /\.(?:ts|tsx|js)$/.test(specifier)) {
    const target = new URL(specifier, context.parentURL);
    if (target.protocol === 'file:' && target.pathname.includes('/apps/desktop/')) {
      if (target.pathname.endsWith('.js')) target.pathname = target.pathname.slice(0, -3) + '.ts';
      if (existsSync(fileURLToPath(target))) return { url: target.href, format: 'module', shortCircuit: true };
    }
  }
  const wantsRaw = specifier.endsWith('?raw');
  if (!wantsRaw && !specifier.endsWith('.md')) {
    const resolved = await nextResolve(specifier, context);
    // Desktop's package is CommonJS, but Host imports its TS services as ESM.
    // Force a single module identity for .ts and .js aliases; otherwise tsx
    // installs owner/userData facts in an ESM copy while stores read a CJS copy.
    if (resolved.url.includes('/apps/desktop/') && /\.tsx?(?:\?|$)/.test(resolved.url)) {
      return { ...resolved, format: 'module' };
    }
    return resolved;
  }
  const bare = wantsRaw ? specifier.slice(0, -'?raw'.length) : specifier;
  const target = bare.startsWith('.') || bare.startsWith('/')
    ? new URL(bare, context.parentURL)
    : new URL((await nextResolve(bare, context)).url);
  if (target.protocol !== 'file:') return nextResolve(specifier, context);
  return { url: `cindy-raw:${target.href}`, shortCircuit: true };
}

export async function load(url, context, nextLoad) {
  // tsx resolves a `?raw` import itself (this hook's resolve then sees the bare path) and puts the query back on the
  // file URL it loads, e.g. Desktop's `page.html?raw` in cindy-brain/forge.ts; load that as raw text too.
  const raw = url.startsWith('cindy-raw:') ? url.slice('cindy-raw:'.length) : /^file:[^?#]*\?raw$/.test(url) ? url.slice(0, -'?raw'.length) : null;
  if (!raw) {
    if (url.includes('/apps/desktop/') && /\.tsx?(?:\?|$)/.test(url)) {
      const filename = fileURLToPath(url);
      const source = await readFile(filename, 'utf8');
      const result = await transform(source, { loader: filename.endsWith('.tsx') ? 'tsx' : 'ts', format: 'esm', target: 'node22', sourcefile: filename, sourcemap: 'inline' });
      return { format: 'module', shortCircuit: true, source: result.code };
    }
    return nextLoad(url, context);
  }
  const filesystemPath = fileURLToPath(raw);
  const text = await readFile(filesystemPath, 'utf8');
  return {
    format: 'module',
    shortCircuit: true,
    source: `export default ${JSON.stringify(text)};`,
  };
}
