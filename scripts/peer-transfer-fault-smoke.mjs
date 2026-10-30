// Real WebRTC + production read policy/cooldown/upload helper. HTTP is an OSS test adapter.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { build } = require('esbuild');
const { chromium } = require('playwright-core');
const bytes = randomBytes(2 * 1024 * 1024 + 7);
const sha256 = createHash('sha256').update(bytes).digest('hex');
let httpReads = 0;
const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url !== '/object') { res.end('peer acceptance'); return; }
  httpReads++;
  res.end(bytes);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  const bundle = await build({ stdin: {
    contents: `export { createFilePeerRuntime } from './packages/device-link/src/filePeerRuntime.ts';
      export { readDeviceFile } from './packages/device-link/src/fileAccess.ts';
      export { createPeerTransferCooldown } from './packages/device-link/src/peerTransferCooldown.ts';
      export { uploadPeerAttachment, parsePeerAttachmentRef } from './packages/device-link/src/peerAttachment.ts';`,
    resolveDir: root, loader: 'ts',
  }, bundle: true, write: false, format: 'iife', globalName: 'Production' });
  browser = await chromium.launch({ executablePath: process.argv[2], headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.exposeFunction('source', offset => bytes.subarray(offset, offset + 16384).toString('base64'));
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(async ({ size, sha256 }) => {
    const { createFilePeerRuntime, readDeviceFile, createPeerTransferCooldown,
      uploadPeerAttachment, parsePeerAttachmentRef } = Production;
    const assert = (ok, message) => { if (!ok) throw new Error(message); };
    const decode = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
    const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)))
      .map(n => n.toString(16).padStart(2, '0')).join('');
    let clock = 0, attempts = 0, fallbacks = 0;
    const cd = createPeerTransferCooldown(() => clock);
    const ticket = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const pairs = [];
    async function connect({ breakAt = Infinity, slow = false } = {}) {
      const output = new Uint8Array(size);
      let written = 0;
      const host = createFilePeerRuntime({
        read: async (_id, _ticket, offset) => {
          if (offset >= breakAt) { host.close('host'); throw new Error('injected disconnect'); }
          return source(offset);
        }, write: async () => { throw new Error('unexpected write'); },
        invoke: async (_id, payload) => payload,
      });
      const client = createFilePeerRuntime({ read: async () => '',
        write: async (_sink, offset, data) => {
          if (slow) await new Promise(resolve => setTimeout(resolve, 2));
          assert(offset === written, 'out-of-order disk writes');
          const chunk = decode(data); output.set(chunk, offset); written += chunk.length;
        },
      });
      pairs.push({ host, client });
      const offer = await client.offer('client', [], true);
      await client.answer('client', await host.accept('host', [], offer));
      return { host, client, output, written: () => written };
    }
    const prepared = { ossKey: '', size, mimeType: 'application/octet-stream', transferRequired: true };
    async function read(pair, signal) {
      return readDeviceFile({ prepare: async () => prepared, signal,
        peer: async () => {
          if (cd.remaining('device-a')) return null;
          attempts++;
          try {
            await pair.client.receive('client', ticket, size, 'sink');
            cd.success('device-a');
            return { ...prepared, ossKey: 'peer', data: pair.output };
          } catch { cd.fail('device-a'); return null; }
        },
        fallback: async () => {
          fallbacks++;
          return { ...prepared, ossKey: 'oss-test-adapter', data: new Uint8Array(await (await fetch('/object')).arrayBuffer()) };
        },
      });
    }
    try {
      const broken = await connect({ breakAt: 512 * 1024 });
      const fallback = await read(broken);
      assert(broken.written() > 0 && broken.written() < size, 'fault must occur mid-file');
      assert(fallback.ossKey === 'oss-test-adapter' && await hash(fallback.data) === sha256, 'fallback integrity');
      await read(broken); await read(broken);
      assert(attempts === 1 && fallbacks === 3, 'cooldown must prevent reconnect attempts');
      assert(cd.remaining('device-b') === 0, 'cooldown leaked across devices');
      clock = 30_001; // Advance the production cooldown clock, not the network clock.
      const recovered = await connect({ slow: true });
      const complete = await read(recovered);
      assert(complete.ossKey === 'peer' && await hash(complete.data) === sha256, 'recovery integrity');
      assert(attempts === 2 && fallbacks === 3 && cd.remaining('device-a') === 0, 'recovery failed');
      const abort = new AbortController(); abort.abort();
      let cancelled = false;
      try { await read(recovered, abort.signal); } catch (e) { cancelled = /CANCELLED/.test(e.message); }
      assert(cancelled && fallbacks === 3, 'cancel triggered fallback');

      // Actual reverse-direction attachment staging over reads-v1, using the shared uploader.
      let staged = new Uint8Array(size), offset = 0, finished = false;
      const receiver = createFilePeerRuntime({ read: async () => '', write: async () => {},
        invoke: async (_id, payload) => {
          const request = JSON.parse(payload);
          if (request.op === 'begin') return JSON.stringify({ ticket });
          if (request.op === 'write') {
            assert(request.offset === offset, 'attachment offset');
            const chunk = decode(request.data); staged.set(chunk, offset); offset += chunk.length;
          }
          if (request.op === 'finish') {
            assert(offset === size && await hash(staged) === sha256, 'attachment integrity'); finished = true;
          }
          return '{}';
        },
      });
      const sender = createFilePeerRuntime({ read: async () => '', write: async () => {} });
      pairs.push({ host: receiver, client: sender });
      await sender.answer('up', await receiver.accept('down', [], await sender.offer('up', [], true)));
      const ref = await uploadPeerAttachment({ size, sha256, originalName: '测试.bin' },
        async (start, length) => {
          // The upload helper asks for 1 MiB; the source bridge exposes 16 KiB blocks.
          let text = '';
          for (let pos = start; pos < Math.min(size, start + length); pos += 16384) text += atob(await source(pos));
          return btoa(text);
        }, async request => JSON.parse(await sender.invoke('up', JSON.stringify(request))), () => {});
      assert(finished && parsePeerAttachmentRef(ref)?.sha256 === sha256, 'attachment finished too soon');
      recovered.host.dispose();
      // Closing this pair must not break a second, already connected pair.
      assert(await sender.invoke('up', JSON.stringify({ op: 'probe' })) === '{}', 'peer isolation');
      return { midTransferFallback: true, sha256Verified: true, cooldownAttempts: attempts,
        fallbackCount: fallbacks, recovery: true, slowSink: true, cancellation: true,
        reverseAttachment: true, peerIsolation: true, cooldownClock: 'virtual' };
    } finally { for (const { host, client } of pairs) { host.dispose(); client.dispose(); } }
  }, { size: bytes.length, sha256 });
  if (httpReads !== 3) throw new Error(`Unexpected fallback HTTP reads: ${httpReads}`);
  console.log(JSON.stringify({ ...result, httpReads }));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
