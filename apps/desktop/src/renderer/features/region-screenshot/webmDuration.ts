/** MediaRecorder writes a streaming WebM without Duration. Finalize its Info so
 * local playback and saved files have a finite, seekable timeline. No remuxing or
 * frame decoding: only the small metadata prefix changes. */
export function finalizeWebmDuration(bytes: Uint8Array<ArrayBuffer>, milliseconds: number): Uint8Array<ArrayBuffer> {
  type Element = { id: number; start: number; sizeAt: number; width: number; data: number; end: number; unknown: boolean };
  function element(start: number, limit: number): Element {
    let at = start;
    function vint(id = false) {
      const first = bytes[at];
      if (!first) throw new Error('Invalid WebM metadata');
      let width = 1, marker = 128;
      while (!(first & marker)) { width++; marker >>= 1; }
      if (width > (id ? 4 : 8) || at + width > limit) throw new Error('Invalid WebM metadata');
      let value = id ? first : first & (marker - 1);
      let unknown = !id && value === marker - 1;
      for (let i = 1; i < width; i++) { const byte = bytes[at + i]; value = value * 256 + byte; unknown &&= byte === 255; }
      at += width;
      return { value, width, unknown };
    }
    const id = vint(true).value, sizeAt = at, size = vint();
    const end = size.unknown ? limit : at + size.value;
    if (!Number.isSafeInteger(end) || end > limit || end <= start) throw new Error('Invalid WebM metadata');
    return { id, start, sizeAt, width: size.width, data: at, end, unknown: size.unknown };
  }
  function children(start: number, end: number): Element[] {
    const result: Element[] = [];
    for (let at = start; at < end;) { const item = element(at, end); result.push(item); at = item.end; }
    return result;
  }
  function join(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
    const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
  }
  function wrap(item: Element, payload: Uint8Array): Uint8Array<ArrayBuffer> {
    let width = item.width;
    while (payload.length >= 2 ** (7 * width) - 1) width++;
    const size = new Uint8Array(width);
    let value = BigInt(payload.length) | (1n << BigInt(7 * width));
    for (let i = width - 1; i >= 0; i--) { size[i] = Number(value & 255n); value >>= 8n; }
    return join([bytes.subarray(item.start, item.sizeAt), item.unknown ? bytes.subarray(item.sizeAt, item.data) : size, payload]);
  }
  const segment = children(0, bytes.length).find((item) => item.id === 0x18538067);
  if (!segment) throw new Error('WebM segment missing');
  const top = children(segment.data, segment.end);
  const info = top.find((item) => item.id === 0x1549a966);
  if (!info) throw new Error('WebM info missing');
  const metadata = children(info.data, info.end);
  if (metadata.some((item) => item.id === 0x4489)) return bytes;
  // This is the streaming MediaRecorder format. Indexed files have offsets that
  // must not be moved; they already carry final metadata and are not our output.
  if (top.some((item) => item.id === 0x114d9b74 || item.id === 0x1c53bb6b)) return bytes;
  const scale = metadata.find((item) => item.id === 0x2ad7b1);
  let nanoseconds = 1_000_000;
  if (scale) { nanoseconds = 0; for (let i = scale.data; i < scale.end; i++) nanoseconds = nanoseconds * 256 + bytes[i]; }
  if (!(nanoseconds > 0) || !Number.isFinite(milliseconds)) throw new Error('Invalid WebM timing');
  const duration = new Uint8Array(11);
  duration.set([0x44, 0x89, 0x88]);
  new DataView(duration.buffer).setFloat64(3, Math.max(1, milliseconds) * 1_000_000 / nanoseconds);
  const nextInfo = wrap(info, join([bytes.subarray(info.data, info.end), duration]));
  const nextSegment = wrap(segment, join([bytes.subarray(segment.data, info.start), nextInfo, bytes.subarray(info.end, segment.end)]));
  return join([bytes.subarray(0, segment.start), nextSegment, bytes.subarray(segment.end)]);
}
