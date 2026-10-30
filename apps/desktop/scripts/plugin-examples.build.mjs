/** Build reviewable demo packages with the production Forge packer; never install them. */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { authorFixture, packAuthorFixture } from './plugin-author-fixture.mjs';
import { pluginUiFixture } from './plugin-ui-fixture.mjs';
const output = path.resolve(process.argv[2] ?? 'tmp/e2e-plugin-ui/demos');
await mkdir(output, { recursive: true });
for (const mode of ['raw', 'sdk', 'files', 'shell']) await authorFixture(mode, output);
for (const raw of [false, true]) await packAuthorFixture(await pluginUiFixture(raw), output);
await authorFixture('files', output, fixture => {
  fixture.manifest.id = 'ui-files-demo';
  fixture.manifest.name = '文件交互演示';
  fixture.manifest.command = 'ui-files-demo';
  fixture.html = fixture.html.replaceAll('acme-ui-showcase', 'ui-files-demo');
  fixture.manifest.network = { hosts: ['p3456-127-0-0-1.lanip.dev'] };
  fixture.main = fixture.main.replaceAll('https://api.example.com', 'https://p3456-127-0-0-1.lanip.dev');
  return fixture;
});
console.log(`DEMO_PACKAGES=${output}`);
