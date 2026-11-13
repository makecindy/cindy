/** Copy the Server-generated registry atomically as data; never merge membership.
 * Usage: node packages/model-providers/scripts/sync-registry.mjs /path/to/providers.json
 */
import { readFile, writeFile, rename } from 'node:fs/promises';
const source = process.argv[2];
if (!source) throw new Error('Pass the Server-generated providers.json path');
const target = new URL('../catalog/model-registry.json', import.meta.url);
const incoming = JSON.parse(await readFile(source, 'utf8')).modelRegistry;
if (!incoming || incoming.schemaVersion !== 6 || !Array.isArray(incoming.interfaceProfiles)) {
  throw new Error('Expected a complete V6 registry');
}
// Presentation order only: every value, deletion and array order comes from Server.
function ordered(old, next) {
  if (Array.isArray(next)) return next.map((item, index) => ordered(
    Array.isArray(old) ? old.find(v => (item?.id && v?.id === item.id) ||
      (item?.modelId && v?.modelId === item.modelId && v?.providerId === item.providerId)) ?? old[index] : undefined, item));
  if (next && typeof next === 'object') return Object.fromEntries(
    [...new Set([...Object.keys(old ?? {}), ...Object.keys(next)])].filter(key => key in next)
      .map(key => [key, ordered(old?.[key], next[key])]),
  );
  return next;
}
const temporary = new URL(`../catalog/model-registry.${process.pid}.tmp`, import.meta.url);
await writeFile(temporary, `${JSON.stringify(ordered(JSON.parse(await readFile(target, 'utf8')), incoming), null, 2)}\n`);
await rename(temporary, target);
