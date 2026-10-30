import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('./', import.meta.url);
const result = await build({ entryPoints: [fileURLToPath(new URL('ui/app.js', root))], bundle: true, write: false, format: 'esm', minify: true });
const template = await readFile(new URL('ui/page.template.html', root), 'utf8');
const script = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
await writeFile(new URL('ui/page.html', root), template.replace('<!-- APP_SCRIPT -->', () => `<script type="module">${script}</script>`));
