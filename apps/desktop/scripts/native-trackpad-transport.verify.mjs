/** Live transport tier, independent of desktop focus. This does not test AppKit.
 * Usage: node native-trackpad-transport.verify.mjs /path/to/private-viewer-url
 * The URL/cookie stay in memory and are never printed. Requires an already
 * booted, authorized test device with a zoomable app in the foreground. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const url = new URL(fs.readFileSync(process.argv[2], 'utf8').trim());
assert.equal(url.protocol, 'http:');
assert(['127.0.0.1', 'localhost'].includes(url.hostname));
const udid = url.searchParams.get('udid');
const token = new URLSearchParams(url.hash.slice(1)).get('cindyClipboard')?.split('.')[1];
assert(udid && token);
const auth = await fetch(url.origin + '/control-api', {
  method: 'POST',
  headers: { Origin: url.origin, 'X-Cindy-Clipboard': token },
  body: JSON.stringify({ action: 'status', udid }),
});
assert.equal(auth.status, 200);
const cookie = auth.headers.get('set-cookie')?.split(';')[0];
assert(cookie);
const socket = new WebSocket(
  url.origin.replace('http:', 'ws:') +
    `/simulators/${encodeURIComponent(udid)}/stream?format=avcc&version=v2`,
  {
    headers: { Origin: url.origin, Cookie: cookie },
  },
);
const timeout = setTimeout(() => {
  socket.terminate();
  process.exitCode = 1;
}, 15000);
let frames = [],
  errors = 0;
socket.on('message', (data, binary) => {
  if (binary && [2, 3].includes(data[0])) frames.push(performance.now());
  if (!binary) {
    try {
      const p = JSON.parse(data);
      if (p.ok === false || p.type === 'error') errors++;
    } catch {}
  }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  for (let i = 0; i < 100 && frames.length < 3; i++) await sleep(50);
  assert(frames.length >= 3, 'Video stream did not become ready');
  const send = (phase, span) =>
    socket.send(
      JSON.stringify({
        type: 'touch2-' + phase,
        width: 440,
        height: 956,
        x1: 220 - span * 440,
        x2: 220 + span * 440,
        y1: 286.8,
        y2: 286.8,
      }),
    );
  frames = [];
  const start = performance.now();
  send('down', 0.12);
  for (let i = 0; i < 100; i++) {
    send('move', 0.12 + i * 0.0018);
    await sleep(8);
  }
  for (let i = 98; i >= 0; i--) {
    send('move', 0.12 + i * 0.0018);
    await sleep(8);
  }
  send('up', 0.12);
  await sleep(250);
  const elapsed = performance.now() - start;
  const gaps = frames
    .slice(1)
    .map((at, i) => at - frames[i])
    .sort((a, b) => a - b);
  console.log(
    'TRANSPORT_METRICS',
    JSON.stringify({
      frames: frames.length,
      elapsedMs: Math.round(elapsed),
      fps: Number(((frames.length / elapsed) * 1000).toFixed(1)),
      p95FrameGapMs: Number(gaps[Math.floor(gaps.length * 0.95)]?.toFixed(1)),
      errors,
    }),
  );
  assert.equal(errors, 0);
  assert(frames.length >= 70, 'Interactive video cadence is still low');
} finally {
  clearTimeout(timeout);
  socket.terminate();
}
