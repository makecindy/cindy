/**
 * base64 → gunzip → UTF-8 text, self-contained so it can run on a background worklet runtime.
 *
 * pako cannot be captured by a worklet, and a large result decoded with it on the JS thread
 * blocks every timer and press handler. Everything here therefore lives inside one 'worklet'
 * function with no outer references. Off a native runtime the directive is an inert string,
 * which lets tests compare this directly against Node's zlib.
 */
export type GunzipWorkletResult =
  | { ok: true; text: string }
  | { ok: false; limitExceeded: boolean; message: string };

export function gunzipBase64Worklet(base64: string, maxChars: number): GunzipWorkletResult {
  'worklet';
  const LIMIT = 'decompressed text exceeds limit';
  try {
    // --- base64 ---
    let end = base64.length;
    while (end > 0 && base64.charCodeAt(end - 1) === 61) end -= 1;
    const input = new Uint8Array(Math.floor((end * 3) / 4));
    let written = 0;
    let bitBuffer = 0;
    let bitCount = 0;
    for (let i = 0; i < end; i += 1) {
      const c = base64.charCodeAt(i);
      let v: number;
      if (c >= 65 && c <= 90) v = c - 65;
      else if (c >= 97 && c <= 122) v = c - 71;
      else if (c >= 48 && c <= 57) v = c + 4;
      else if (c === 43) v = 62;
      else if (c === 47) v = 63;
      else throw new Error('invalid base64');
      bitBuffer = ((bitBuffer << 6) | v) & 0xffffff;
      bitCount += 6;
      if (bitCount >= 8) {
        bitCount -= 8;
        input[written++] = (bitBuffer >> bitCount) & 0xff;
      }
    }

    // --- gzip header (RFC 1952) ---
    if (written < 18 || input[0] !== 0x1f || input[1] !== 0x8b || input[2] !== 8) {
      throw new Error('not a gzip stream');
    }
    const flags = input[3];
    let pos = 10;
    if (flags & 4) pos += 2 + (input[pos] | (input[pos + 1] << 8));
    if (flags & 8) {
      while (pos < written && input[pos] !== 0) pos += 1;
      pos += 1;
    }
    if (flags & 16) {
      while (pos < written && input[pos] !== 0) pos += 1;
      pos += 1;
    }
    if (flags & 2) pos += 2;

    // --- inflate (RFC 1951) ---
    // UTF-8 uses at most 3 bytes per UTF-16 code unit, so this bound never rejects valid text.
    const maxBytes = maxChars * 3;
    let out = new Uint8Array(Math.min(Math.max(written * 4, 1 << 16), maxBytes + 1));
    let outLength = 0;
    const reserve = (extra: number) => {
      const needed = outLength + extra;
      if (needed > maxBytes) throw new RangeError(LIMIT);
      if (needed <= out.length) return;
      let capacity = out.length;
      while (capacity < needed) capacity *= 2;
      const grown = new Uint8Array(Math.min(capacity, maxBytes));
      grown.set(out.subarray(0, outLength));
      out = grown;
    };
    let hold = 0;
    let held = 0;
    const bits = (count: number): number => {
      while (held < count) {
        if (pos >= written) throw new Error('truncated gzip stream');
        hold |= input[pos++] << held;
        held += 8;
      }
      const value = hold & ((1 << count) - 1);
      hold >>>= count;
      held -= count;
      return value;
    };
    type Table = { counts: Uint16Array; symbols: Uint16Array };
    const build = (lengths: Uint8Array, offset: number, count: number): Table => {
      const counts = new Uint16Array(16);
      const symbols = new Uint16Array(count);
      for (let i = 0; i < count; i += 1) counts[lengths[offset + i]] += 1;
      counts[0] = 0;
      const offsets = new Uint16Array(16);
      for (let i = 1; i < 16; i += 1) offsets[i] = offsets[i - 1] + counts[i - 1];
      for (let i = 0; i < count; i += 1) {
        const length = lengths[offset + i];
        if (length) symbols[offsets[length]++] = i;
      }
      return { counts, symbols };
    };
    const decode = (table: Table): number => {
      let code = 0;
      let first = 0;
      let index = 0;
      for (let length = 1; length < 16; length += 1) {
        code |= bits(1);
        const count = table.counts[length];
        if (code - first < count) return table.symbols[index + (code - first)];
        index += count;
        first = (first + count) << 1;
        code <<= 1;
      }
      throw new Error('invalid huffman code');
    };
    const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
    const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
    const DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
    const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
    const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
    let fixedTables: { literal: Table; distance: Table } | null = null;
    let final = false;
    while (!final) {
      final = bits(1) === 1;
      const type = bits(2);
      if (type === 0) {
        hold = 0;
        held = 0;
        if (pos + 4 > written) throw new Error('truncated gzip stream');
        const length = input[pos] | (input[pos + 1] << 8);
        const complement = input[pos + 2] | (input[pos + 3] << 8);
        pos += 4;
        if ((length ^ 0xffff) !== complement) throw new Error('invalid stored block');
        if (pos + length > written) throw new Error('truncated gzip stream');
        reserve(length);
        out.set(input.subarray(pos, pos + length), outLength);
        outLength += length;
        pos += length;
        continue;
      }
      if (type === 3) throw new Error('invalid block type');
      let literal: Table;
      let distance: Table;
      if (type === 1) {
        if (!fixedTables) {
          const lengths = new Uint8Array(320);
          for (let i = 0; i < 288; i += 1) lengths[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
          for (let i = 288; i < 320; i += 1) lengths[i] = 5;
          fixedTables = { literal: build(lengths, 0, 288), distance: build(lengths, 288, 32) };
        }
        literal = fixedTables.literal;
        distance = fixedTables.distance;
      } else {
        const literalCount = bits(5) + 257;
        const distanceCount = bits(5) + 1;
        const codeCount = bits(4) + 4;
        const lengths = new Uint8Array(320);
        for (let i = 0; i < codeCount; i += 1) lengths[CODE_LENGTH_ORDER[i]] = bits(3);
        const codeTable = build(lengths, 0, 19);
        lengths.fill(0);
        let index = 0;
        while (index < literalCount + distanceCount) {
          const symbol = decode(codeTable);
          if (symbol < 16) {
            lengths[index++] = symbol;
            continue;
          }
          let previous = 0;
          let repeat: number;
          if (symbol === 16) {
            if (index === 0) throw new Error('invalid code lengths');
            previous = lengths[index - 1];
            repeat = 3 + bits(2);
          } else if (symbol === 17) repeat = 3 + bits(3);
          else repeat = 11 + bits(7);
          if (index + repeat > literalCount + distanceCount) throw new Error('invalid code lengths');
          while (repeat-- > 0) lengths[index++] = previous;
        }
        literal = build(lengths, 0, literalCount);
        distance = build(lengths, literalCount, distanceCount);
      }
      for (;;) {
        const symbol = decode(literal);
        if (symbol < 256) {
          reserve(1);
          out[outLength++] = symbol;
          continue;
        }
        if (symbol === 256) break;
        const lengthIndex = symbol - 257;
        if (lengthIndex >= 29) throw new Error('invalid length code');
        const length = LENGTH_BASE[lengthIndex] + bits(LENGTH_EXTRA[lengthIndex]);
        const distanceIndex = decode(distance);
        if (distanceIndex >= 30) throw new Error('invalid distance code');
        const back = DISTANCE_BASE[distanceIndex] + bits(DISTANCE_EXTRA[distanceIndex]);
        if (back > outLength) throw new Error('invalid distance');
        reserve(length);
        // Overlapping copies are defined byte by byte; `copyWithin` would not repeat the run.
        for (let i = 0; i < length; i += 1) {
          out[outLength] = out[outLength - back];
          outLength += 1;
        }
      }
    }

    // --- gzip trailer: CRC32 of the output, then ISIZE (output length modulo 2^32). ---
    pos -= Math.floor(held / 8);
    if (pos + 8 > written) throw new Error('truncated gzip stream');
    const expectedCrc = (input[pos] | (input[pos + 1] << 8) | (input[pos + 2] << 16)
      | (input[pos + 3] << 24)) >>> 0;
    const crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    let crc = 0xffffffff;
    for (let n = 0; n < outLength; n += 1) crc = crcTable[(crc ^ out[n]) & 0xff] ^ (crc >>> 8);
    if (((crc ^ 0xffffffff) >>> 0) !== expectedCrc) throw new Error('gzip crc mismatch');
    const expected = (input[pos + 4] | (input[pos + 5] << 8) | (input[pos + 6] << 16)
      | (input[pos + 7] << 24)) >>> 0;
    if (expected !== outLength >>> 0) throw new Error('gzip length mismatch');

    // --- UTF-8 → UTF-16 ---
    const parts: string[] = [];
    let units: number[] = [];
    let chars = 0;
    const push = (unit: number) => {
      chars += 1;
      if (chars > maxChars) throw new RangeError(LIMIT);
      units.push(unit);
      if (units.length >= 8192) {
        parts.push(String.fromCharCode.apply(null, units));
        units = [];
      }
    };
    let i = 0;
    while (i < outLength) {
      const lead = out[i++];
      if (lead < 0x80) {
        push(lead);
        continue;
      }
      const need = lead >= 0xf0 && lead <= 0xf4 ? 3 : lead >= 0xe0 && lead < 0xf0 ? 2 : lead >= 0xc2 && lead < 0xe0 ? 1 : 0;
      if (need === 0) {
        push(0xfffd);
        continue;
      }
      let cp = lead & (need === 1 ? 0x1f : need === 2 ? 0x0f : 0x07);
      let valid = true;
      for (let k = 0; k < need; k += 1) {
        const next = i < outLength ? out[i] : 0;
        const low = k === 0 && lead === 0xe0 ? 0xa0 : k === 0 && lead === 0xf0 ? 0x90 : 0x80;
        const high = k === 0 && lead === 0xed ? 0x9f : k === 0 && lead === 0xf4 ? 0x8f : 0xbf;
        if (next < low || next > high) {
          valid = false;
          break;
        }
        cp = (cp << 6) | (next & 0x3f);
        i += 1;
      }
      if (!valid) {
        push(0xfffd);
      } else if (cp >= 0x10000) {
        cp -= 0x10000;
        push(0xd800 | (cp >> 10));
        push(0xdc00 | (cp & 0x3ff));
      } else {
        push(cp);
      }
    }
    if (units.length) parts.push(String.fromCharCode.apply(null, units));
    return { ok: true, text: parts.join('') };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, limitExceeded: message === LIMIT, message };
  }
}
