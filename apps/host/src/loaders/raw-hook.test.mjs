import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const exec = promisify(execFile);
// The required Host gate runs from the issue worktree, whose path includes spaces.
// Exercise Node's real loader validation and the original asset bytes, not a mocked hook.
// Architecture §5 Host gate regression: existing Host tests never import raw assets from a
// URL-sensitive fixture path. Kept here because this tests the Node loader itself, using one
// real child process; the filename stays valid on Windows as well as macOS/Linux.
// Unit tier; synthetic temporary files only, no account/runtime or Electron process.
test('raw asset imports preserve spaces, Unicode and URL delimiters through the Node loader', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cindy raw-'));
  try {
    const asset = path.join(root, '提示 #100%.md');
    const text = 'Synthetic prompt\nLiteral # and % stay intact.\n';
    await writeFile(asset, text);
    const assetUrl = pathToFileURL(asset);
    assetUrl.search = 'raw';
    const specifier = assetUrl.href;
    const loader = new URL('./register-raw.mjs', import.meta.url).href;
    const script = `const asset = await import(${JSON.stringify(specifier)}); process.stdout.write(asset.default);`;
    const { stdout } = await exec(process.execPath, ['--import', loader, '--input-type=module', '-e', script]);
    assert.equal(stdout, text);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Unit: the production tsx + Host loader chain must return text for a non-Markdown asset.
// Markdown alone also matches the extension fallback and misses the HTML import that stops serve.
test('the Host loader chain imports HTML with ?raw and plain Markdown as text', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'host raw-'));
  try {
    const html = path.join(root, 'page.html');
    const markdown = path.join(root, 'prompt.md');
    await writeFile(html, '<p>example</p>\n');
    await writeFile(markdown, '# Example\n');
    const loader = new URL('./register-raw.mjs', import.meta.url).href;
    const htmlUrl = pathToFileURL(html);
    htmlUrl.search = 'raw';
    const script = `import html from ${JSON.stringify(htmlUrl.href)};
      import md from ${JSON.stringify(pathToFileURL(markdown).href)};
      process.stdout.write(JSON.stringify([html, md]));`;
    const { stdout } = await exec(process.execPath, ['--import', 'tsx', '--import', loader, '--input-type=module', '-e', script]);
    assert.deepEqual(JSON.parse(stdout), ['<p>example</p>\n', '# Example\n']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
