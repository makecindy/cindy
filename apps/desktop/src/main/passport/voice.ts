/** Passport voice characteristic v1: kind, uint32 token, uint16 sequence, payload.
 * Fixed 16 kHz mono Opus, 40 ms / <=120 bytes. Never transcribe partial audio.
 */
export class PassportVoice {
  private recording: { token: number; id: string; packets: Buffer[]; started: number } | null = null;
  reset(): void { this.recording = null; }
  accept(packet: Buffer, canRecord: (id: string) => boolean, now = Date.now()): { id: string; token: number; audio: Buffer } | null {
    try { return this.read(packet, canRecord, now); }
    catch (error) { this.reset(); throw error; }
  }
  private read(p: Buffer, canRecord: (id: string) => boolean, now: number): { id: string; token: number; audio: Buffer } | null {
    if (p.length < 7 || p.length > 127) throw new Error('Invalid voice packet');
    const kind = p[0], token = p.readUInt32LE(1), sequence = p.readUInt16LE(5);
    if (kind === 1) {
      if (this.recording || p.length !== 47 || sequence !== 0) throw new Error('Invalid voice start');
      const raw = p.subarray(7), end = raw.indexOf(0);
      if (end <= 0 || raw.subarray(end).some((byte) => byte !== 0)) throw new Error('Invalid voice task');
      const id = new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(0, end));
      if (!canRecord(id)) throw new Error('Voice task unavailable');
      this.recording = { token, id, packets: [], started: now };
      return null;
    }
    const r = this.recording;
    if (!r || r.token !== token || sequence !== r.packets.length || now - r.started > 45000 || !canRecord(r.id))
      throw new Error('Interrupted voice recording');
    if (kind === 4 && p.length === 7) { this.reset(); return null; }
    if (kind === 2 && p.length >= 8 && p.length <= 127 && r.packets.length < 752) {
      r.packets.push(Buffer.from(p.subarray(7))); return null;
    }
    if (kind !== 3 || p.length !== 7 || !r.packets.length) throw new Error('Invalid voice finish');
    this.reset();
    return { id: r.id, token: r.token, audio: opusOgg(r.packets, r.token) };
  }
}

/** One complete packet per Ogg page; bounded packets never need continuation. */
export function opusOgg(packets: readonly Buffer[], serial: number): Buffer {
  const head = Buffer.alloc(19);
  head.write('OpusHead'); head[8] = 1; head[9] = 1; head.writeUInt32LE(16000, 12);
  // Keep encoder delay and the final silent flush: no guessed preskip value.
  const tags = Buffer.alloc(16); tags.write('OpusTags');
  const page = (payload: Buffer, index: number, flags: number, granule: number): Buffer => {
    if (payload.length >= 255) throw new Error('Oversized Opus packet');
    const out = Buffer.alloc(28 + payload.length);
    out.write('OggS'); out[5] = flags; out.writeBigUInt64LE(BigInt(granule), 6);
    out.writeUInt32LE(serial, 14); out.writeUInt32LE(index, 18);
    out[26] = 1; out[27] = payload.length; payload.copy(out, 28);
    let crc = 0;
    for (const byte of out) {
      crc ^= byte << 24;
      for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0);
    }
    out.writeUInt32LE(crc >>> 0, 22); return out;
  };
  return Buffer.concat([page(head, 0, 2, 0), page(tags, 1, 0, 0),
    // Ogg Opus granules always use 48 kHz, independent of the 16 kHz input.
    ...packets.map((p, i) => page(p, i + 2, i === packets.length - 1 ? 4 : 0, (i + 1) * 1920))]);
}
