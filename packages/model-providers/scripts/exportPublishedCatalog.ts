/** Generate reviewed offline build artifacts from a published API, never edit a second server source. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCatalog } from '../src/catalog.js';

const [source, directory] = process.argv.slice(2);
if (!source || !directory)
  throw new Error(
    'Usage: tsx exportPublishedCatalog.ts <published-catalog-url> <output-directory>',
  );
const url = new URL(source);
if (url.protocol !== 'https:' || url.username || url.password)
  throw new Error('Expected a public HTTPS catalog URL');
url.searchParams.set('registrySchemaVersion', '5');
const response = await fetch(url, {
  redirect: 'error',
  signal: AbortSignal.timeout(15000),
});
if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
const reader = response.body?.getReader();
if (!reader) throw new Error('Catalog is empty');
const chunks: Uint8Array[] = [];
let size = 0;
try {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 2000000) {
      await reader.cancel();
      throw new Error('Catalog exceeds 2 MB');
    }
    chunks.push(value);
  }
} finally {
  reader.releaseLock();
}
const body = Buffer.concat(chunks).toString('utf8');
const catalog = parseCatalog(body);
if (catalog.modelRegistry?.schemaVersion !== 5)
  throw new Error('Source has not published Registry V5');
const raw = JSON.parse(body);
const { modelRegistry, ...providers } = raw;
await mkdir(directory, { recursive: true });
for (const [name, value] of [
  ['providers.json', providers],
  ['model-registry.json', modelRegistry],
] as const) {
  await writeFile(
    join(directory, name),
    JSON.stringify(value, null, 2) + '\n',
    { flag: 'wx' },
  );
}
process.stdout.write(
  `Exported ${catalog.version}. Review the diff before replacing the bundled offline artifacts. Pi native catalog remains pinned to its harness version.\n`,
);
