/** Build reviewable demo packages with the production Forge packer; never install them. */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { authorFixture, packAuthorFixture } from './plugin-author-fixture.mjs';
import { pluginUiFixture } from './plugin-ui-fixture.mjs';
const output = path.resolve(process.argv[2] ?? 'tmp/e2e-plugin-ui/demos');
await mkdir(output, { recursive: true });
for (const mode of ['static', 'loader', 'files']) await authorFixture(mode, output);
for (const raw of [false, true]) await packAuthorFixture(await pluginUiFixture(raw), output);
console.log(`DEMO_PACKAGES=${output}`);
