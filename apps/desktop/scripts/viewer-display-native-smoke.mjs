/** Explicit macOS integration test: temporarily mirrors the main desktop, then restores it.
 * Run: node apps/desktop/scripts/viewer-display-native-smoke.mjs
 * No captures or input injection. Not part of the default unit suite.
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

assert.equal(process.platform, 'darwin');
const exec = promisify(execFile);
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-viewer-display-smoke-'));
const source = fileURLToPath(
  new URL('../native/remote-desktop/macos-viewer-display.m', import.meta.url),
);
const binary = path.join(directory, 'display');
const query = `import CoreGraphics
import Foundation
var ids = [CGDirectDisplayID](repeating: 0, count: 32)
var count: UInt32 = 0
CGGetOnlineDisplayList(32, &ids, &count)
let result = ids.prefix(Int(count)).map { id -> [String: Any] in
 let bounds = CGDisplayBounds(id)
 return ["id": id, "width": bounds.width, "height": bounds.height, "main": CGDisplayIsMain(id), "mirror": CGDisplayMirrorsDisplay(id)]
}
print(String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)`;
const displays = async () =>
  JSON.parse((await exec('swift', ['-e', query], { timeout: 30_000 })).stdout);
let child;
try {
  await exec(
    'clang',
    ['-fobjc-arc', '-framework', 'Foundation', '-framework', 'CoreGraphics', source, '-o', binary],
    { timeout: 60_000 },
  );
  const before = await displays();
  const main = before.find((d) => d.main === 1);
  assert(main && main.mirror === 0);
  child = spawn(binary, [], { stdio: 'pipe' });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const change = async (width, height) => {
    const reply = once(lines, 'line', { signal: AbortSignal.timeout(10_000) });
    child.stdin.write(JSON.stringify({ sourceDisplayId: String(main.id), width, height }) + '\n');
    const value = JSON.parse((await reply)[0]);
    assert.equal(value.error, undefined);
    const actual = await displays();
    const mirror = actual.find((d) => d.id === main.id);
    const virtual = actual.find((d) => d.id === value.id);
    assert.equal(mirror.mirror, value.id);
    assert.equal(virtual.width, width);
    assert.equal(virtual.height, height);
    assert.equal(mirror.width, width);
    assert.equal(mirror.height, height);
    console.log(JSON.stringify({ phase: 'resized', width, height, virtualId: value.id }));
  };
  await change(900, 1600);
  await change(1600, 900);
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(10_000) });
  child.stdin.end();
  await exited;
  lines.close();
  child = undefined;
  const after = await displays();
  assert.deepEqual(after, before);
  console.log(JSON.stringify({ phase: 'restored', displays: after }));
} finally {
  if (child) {
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(10_000) }).catch(() => {});
    child.kill('SIGTERM');
    await exited;
  }
  await fs.rm(directory, { recursive: true, force: true });
}
