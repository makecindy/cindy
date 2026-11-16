import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { openSystemBrowser } from './browser-open.mjs';

// The opener's real process result is the boundary under test; no system
// browser, user account or reusable pairing URL is used here.
for (const platform of ['darwin', 'win32', 'linux']) test(`browser opening waits for the ${platform} opener's exit`, async () => {
  const child = new EventEmitter(); child.unref = () => {};
  let done = false;
  const result = openSystemBrowser('https://example.invalid/#synthetic', {
    platform, spawnProcess(command, args, options) {
      assert.equal(command, { darwin: 'open', win32: 'rundll32.exe', linux: 'xdg-open' }[platform]);
      assert.equal(args.at(-1), 'https://example.invalid/#synthetic');
      assert.equal(options.stdio, 'ignore');
      return child;
    },
  }).then(() => { done = true; });
  child.emit('spawn'); await Promise.resolve(); assert.equal(done, false);
  child.emit('close', 0); await result; assert.equal(done, true);
});

test('a failed opener never reports success or includes the pairing URL', async () => {
  const child = new EventEmitter(); child.unref = () => {};
  const result = openSystemBrowser('https://example.invalid/#private-pair', { spawnProcess: () => child });
  child.emit('error', new Error('spawn https://example.invalid/#private-pair failed'));
  await assert.rejects(result, error => !error.message.includes('private-pair') && /unavailable/.test(error.message));
  child.emit('close', 1);
});

test('no graphical browser produces an actionable failure', async () => {
  const child = new EventEmitter(); child.unref = () => {};
  const result = openSystemBrowser('https://example.invalid', { spawnProcess: () => child });
  child.emit('close', 3);
  await assert.rejects(result, /connected client/);
});
