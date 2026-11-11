import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createMediaTransfer, AttachmentIntegrityError } from '../../desktop/src/main/device-link/mediaTransfer.js';

const srcDir = path.dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(mjs|ts)$/.test(entry.name) && !entry.name.endsWith('.test.mjs') ? [full] : [];
  });
}

test('host sources never import Electron', () => {
  const offenders = [];
  for (const file of sourceFiles(srcDir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g)) {
      const spec = match[1] ?? match[2];
      if (spec === 'electron' || spec.startsWith('electron/')) {
        offenders.push(`${path.relative(srcDir, file)} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `host must not depend on Electron:\n${offenders.join('\n')}`);
});

// architecture-invariants §5: the shared transfer must run in Node without the
// Electron assembly. Desktop transport mocks cannot catch that load boundary.
// Unit: download bytes through the real factory; a same-size corrupt response
// must preserve the previous file and remove the unpublished partial download.
test('Node media transfer publishes only integrity-checked attachment bytes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-media-transfer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'attachment.txt');
  const bytes = Buffer.from('verified attachment');
  let received = bytes;
  const transfer = createMediaTransfer({
    fetch: async () => new Response(received),
    uploadFetch: async () => { throw new Error('unexpected upload'); },
    deviceLinkApiFetch: async () => ({ getUrl: 'https://media.invalid/fixture' }),
    officialDeviceLinkApiFetch: async () => { throw new Error('unexpected shared-task route'); },
    requireAppCapability: () => {},
  });
  const expected = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  await transfer.downloadToFile('fixture-key', target, expected);
  assert.deepEqual(fs.readFileSync(target), bytes);
  received = Buffer.alloc(bytes.length, 0);
  await assert.rejects(transfer.downloadToFile('fixture-key', target, expected),
    (error) => error instanceof AttachmentIntegrityError && error.reason === 'sha256');
  assert.deepEqual(fs.readFileSync(target), bytes);
  assert.deepEqual(fs.readdirSync(dir), ['attachment.txt']);
});
