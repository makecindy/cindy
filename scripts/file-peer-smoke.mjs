// Real browser checks against production transport code. No account or user files required.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { build } = require('esbuild');
const { chromium } = require('playwright-core');
const executablePath = process.argv[2];
if (!executablePath) throw new Error('Pass a Chrome executable');
const output = await build({ entryPoints: [path.join(root, 'packages/device-link/src/filePeerRuntimeSource.ts')], bundle: true, write: false, format: 'iife', globalName: 'PeerRuntimeSource' });
const browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true });
try {
  const page = await browser.newPage();
  await page.addScriptTag({ content: output.outputFiles[0].text });
  await page.addScriptTag({ content: await page.evaluate(() => PeerRuntimeSource.FILE_PEER_RUNTIME_SOURCE) });
  const result = await page.evaluate(async (large) => {
    const { createFilePeerRuntime } = CindyFilePeerRuntime;
    let sourceSize = 0, outputSize = 0, sourceOffset = 0, failWrite = false;
    const ticket = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const host = createFilePeerRuntime({
      read: async (_id, t, offset) => {
        if (t !== ticket || offset !== sourceOffset) throw new Error('source offset');
        const chunk = Uint8Array.from({ length: Math.min(16384, sourceSize - offset) }, (_, i) => ((offset + i) * 31) % 251); sourceOffset += chunk.length;
        return btoa(String.fromCharCode(...chunk));
      }, write: async () => { throw new Error('host write'); },
    });
    const client = createFilePeerRuntime({ read: async () => { throw new Error('client read'); },
      write: async (_sink, offset, data) => {
        if (failWrite) throw new Error('disk full');
        if (offset !== outputSize) throw new Error('sink offset');
        for (const c of atob(data)) { if (c.charCodeAt(0) !== (outputSize * 31) % 251) throw new Error('bytes differ'); outputSize++; }
      },
    });
    const offer = await client.offer('client', []);
    await client.answer('client', await host.accept('host', [], offer));
    const sizes = [0, 1, 16384, 16385, 262144, 262145, 1048576, ...(large ? [large === '2g' ? 2 * 1024 * 1024 * 1024 : 101 * 1024 * 1024] : [])];
    try {
      for (const size of sizes) {
        sourceSize = size; sourceOffset = 0; outputSize = 0;
        await client.receive('client', ticket, size, 'sink');
        if (outputSize !== size) throw new Error('bytes differ');
      }
      sourceSize = 10; sourceOffset = 0; outputSize = 0; failWrite = true;
      let rejected = false;
      try { await client.receive('client', ticket, 10, 'sink'); } catch { rejected = true; }
      if (!rejected) throw new Error('incomplete sink accepted');
      return { passedSizes: sizes, diskFailureRejected: rejected };
    } finally { host.dispose(); client.dispose(); }
  }, process.argv.includes('--2g') ? '2g' : process.argv.includes('--large'));
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
