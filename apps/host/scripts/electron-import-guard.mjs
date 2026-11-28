// Module resolve hook for check-e2e-imports.mjs: an import of electron fails with the chain of
// importers that reached it. Registered by that script's child process, after tsx and the raw
// loader, so it sees every specifier first.
// Covers ESM imports (static and dynamic), which is how the shared desktop modules load under tsx.

const root = new URL('../../../', import.meta.url).href;
/** First importer seen for each resolved module URL. */
const parents = new Map();
const short = (url) => (url.startsWith(root) ? url.slice(root.length) : url);

export async function resolve(specifier, context, next) {
  if (specifier === 'electron' || specifier.startsWith('electron/')) {
    const chain = [specifier];
    const seen = new Set();
    for (let at = context.parentURL; at && !seen.has(at); at = parents.get(at)) {
      seen.add(at);
      chain.push(short(at));
    }
    throw new Error(`ELECTRON_IMPORT: ${chain.reverse().join(' -> ')}`);
  }
  const result = await next(specifier, context);
  if (context.parentURL && !parents.has(result.url)) parents.set(result.url, context.parentURL);
  return result;
}
