import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { pluginUiFixture } from './plugin-ui-fixture.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../tmp/e2e-plugin-ui');
await mkdir(root, { recursive: true });
for (const raw of [false, true]) {
  const fixture = await pluginUiFixture(raw);
  const files = { 'ghost.json': JSON.stringify(fixture.manifest, null, 2), 'main.js': fixture.main, 'ui/planner.html': fixture.html };
  const zip = new JSZip();
  for (const [name, body] of Object.entries(files)) {
    const destination = path.join(root, fixture.manifest.id, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, body);
    zip.file(name, body);
  }
  await writeFile(path.join(root, fixture.manifest.id + '.cindy'), await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  console.log(fixture.manifest.id + '.cindy');
}
