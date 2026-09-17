import { describe, expect, it } from 'vitest';
import { PassportVoice } from '../voice.js';

function packet(kind: number, sequence: number, payload = Buffer.alloc(0), token = 123): Buffer {
  const p = Buffer.alloc(7 + payload.length); p[0] = kind;
  p.writeUInt32LE(token, 1); p.writeUInt16LE(sequence, 5); payload.copy(p, 7); return p;
}
function start(v: PassportVoice): void {
  const id = Buffer.alloc(40); id.write('task');
  expect(v.accept(packet(1, 0, id), () => true, 0)).toBeNull();
}
describe('Passport voice', () => {
  it('only emits a complete bounded Ogg stream on finish', () => {
    const v = new PassportVoice(); start(v);
    expect(v.accept(packet(2, 0, Buffer.alloc(80)), () => true, 1)).toBeNull();
    const result = v.accept(packet(3, 1), () => true, 2)!;
    expect(result.id).toBe('task');
    expect(result.audio.subarray(0, 4).toString()).toBe('OggS');
    expect(result.audio.subarray(28, 36).toString()).toBe('OpusHead');
    const final = result.audio.subarray(47 + 44);
    expect(final[5]).toBe(4); expect(final.readBigUInt64LE(6)).toBe(1920n);
    expect(final.readUInt32LE(22)).not.toBe(0);
  });
  it('counts 40 ms packets on the fixed 48 kHz Ogg Opus clock', () => {
    const v = new PassportVoice(); start(v);
    v.accept(packet(2, 0, Buffer.alloc(80)), () => true, 1);
    v.accept(packet(2, 1, Buffer.alloc(80)), () => true, 2);
    const audio = v.accept(packet(3, 2), () => true, 3)!.audio;
    const first = audio.subarray(47 + 44);
    const last = first.subarray(28 + 80);
    expect(first[5]).toBe(0);
    expect(first.readUInt32LE(18)).toBe(2);
    expect(first.readBigUInt64LE(6)).toBe(1920n);
    expect(last[5]).toBe(4);
    expect(last.readUInt32LE(18)).toBe(3);
    expect(last.readBigUInt64LE(6)).toBe(3840n);
  });
  it.each(['sequence', 'token', 'owner', 'timeout', 'size', 'restart'])('rejects %s and discards the whole recording', (fault) => {
    const v = new PassportVoice(); start(v);
    expect(() => v.accept(packet(fault === 'restart' ? 1 : 2, fault === 'sequence' ? 1 : 0,
      Buffer.alloc(fault === 'size' ? 121 : 80), fault === 'token' ? 124 : 123),
    () => fault !== 'owner', fault === 'timeout' ? 45001 : 1)).toThrow();
    expect(() => v.accept(packet(3, 0), () => true, 2)).toThrow();
  });
  it('never transcribes cancelled or disconnected recordings', () => {
    const v = new PassportVoice(); start(v);
    expect(v.accept(packet(4, 0), () => true, 1)).toBeNull();
    start(v); v.reset(); expect(() => v.accept(packet(3, 0), () => true, 2)).toThrow();
  });
  it('rejects recordings above the 30 second plus flush limit', () => {
    const v = new PassportVoice(); start(v);
    for (let i = 0; i < 752; i++) v.accept(packet(2, i, Buffer.alloc(80)), () => true, i);
    expect(() => v.accept(packet(2, 752, Buffer.alloc(80)), () => true, 753)).toThrow();
  });
});
