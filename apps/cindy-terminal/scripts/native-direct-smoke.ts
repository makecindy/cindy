import assert from 'node:assert/strict';
import wrtc from '@roamhq/wrtc';
import { createNodeDirectRtcRuntime } from '@cindy/device-link';

const runtime = createNodeDirectRtcRuntime(wrtc);
const payload = 'Cindy 中文 🌿\n'.repeat(6000);
let openLeft!: () => void, openRight!: () => void;
let received!: (value: string) => void;
const opened = [new Promise<void>(resolve => { openLeft = resolve; }), new Promise<void>(resolve => { openRight = resolve; })];
const message = new Promise<string>(resolve => { received = resolve; });
const left = runtime.create('left', { open: openLeft, message() {}, drained() {}, closed() {} });
const right = runtime.create('right', { open: openRight, message: received, drained() {}, closed() {} });
const timeout = setTimeout(() => { console.error('NATIVE_RTC_TIMEOUT'); process.exitCode = 1; left.close(); right.close(); }, 12_000);
try {
  const offer = await left.offer();
  const answer = await right.accept(offer);
  await left.answer(answer);
  await Promise.all(opened);
  left.send(payload);
  assert.equal(await message, payload);
  console.log(JSON.stringify({ ok: true, native: true, bytes: Buffer.byteLength(payload), unicode: true }));
} finally {
  clearTimeout(timeout); left.close(); right.close();
}
