/** Stream independently appended Zstandard frames through Node's checksum-validating decoder. */
import { promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { createZstdDecompress, constants } from 'node:zlib';

const MAX_FRAME = 1024 * 1024 * 1024;
const MAX_OUTPUT = 1024 * 1024 * 1024;
/** Compressed bytes handed to the decoder per write; also the read-ahead size. */
const WRITE_CHUNK = 64 * 1024;

export async function* readZstdFrames(file: string, onBytes?: (bytes: number) => void, signal?: AbortSignal): AsyncGenerator<Buffer> {
  const handle = await fs.open(file, 'r');
  let size: number;
  try {
    size = (await handle.stat()).size;
  } catch (error) {
    await handle.close();
    throw error;
  }
  let offset = 0;
  // A frame can contain many tiny blocks. Read ahead in bounded chunks so
  // walking block headers does not issue one filesystem request per block.
  const buffer = Buffer.alloc(64 * 1024);
  let bufferStart = 0, buffered = 0;
  const read = async (count: number): Promise<Buffer> => {
    signal?.throwIfAborted();
    if (count < 0 || offset + count > size) throw new Error('Truncated Zstandard frame');
    if (offset < bufferStart || offset + count > bufferStart + buffered) {
      bufferStart = offset;
      const result = await handle.read(buffer, 0, buffer.length, offset);
      buffered = result.bytesRead;
      if (onBytes && result.bytesRead > 0) onBytes(result.bytesRead);
    }
    if (offset + count > bufferStart + buffered) throw new Error('Truncated Zstandard frame');
    const result = buffer.subarray(offset - bufferStart, offset - bufferStart + count);
    offset += count;
    return result;
  };
  try {
    while (offset < size) {
      signal?.throwIfAborted();
      const start = offset;
      const magicBytes = Buffer.from(await read(4));
      const magic = magicBytes.readUInt32LE();
      if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
        const length = (await read(4)).readUInt32LE();
        if (length > MAX_FRAME || offset + length > size) throw new Error('Invalid Zstandard skippable frame');
        offset += length;
        continue;
      }
      if (magic !== 0xfd2fb528) throw new Error('Invalid Zstandard frame magic');
      const descriptorBytes = Buffer.from(await read(1));
      const descriptor = descriptorBytes[0]!;
      // Bit 3 is Reserved_bit and must be rejected; bit 4 is Unused_bit, which
      // decoders must ignore, so history written with it still decodes elsewhere.
      if (descriptor & 0x08) throw new Error('Invalid Zstandard frame descriptor');
      const single = (descriptor & 0x20) !== 0;
      const headerBytes = [magicBytes, descriptorBytes];
      if (!single) headerBytes.push(Buffer.from(await read(1))); // window descriptor, validated by the native decoder
      const dictionaryFlag = descriptor & 3;
      const contentFlag = descriptor >>> 6;
      const dictionarySize = [0, 1, 2, 4][dictionaryFlag]!;
      const contentSize = contentFlag === 0 ? (single ? 1 : 0) : 1 << contentFlag;
      headerBytes.push(Buffer.from(await read(dictionarySize + contentSize)));
      // Feed the frame to the decoder block by block while validating it. Walking
      // the whole frame first would read every byte before producing the first
      // line, so a scan that only needs a prefix would pay for the entire frame.
      // Coalesce consecutive blocks into bounded writes. A legal frame can hold
      // hundreds of thousands of tiny or empty blocks, and one decoder write per
      // block costs far more than the buffered reads that produce it.
      const feed = async function* (): AsyncGenerator<Buffer> {
        let pending: Buffer[] = [];
        let pendingBytes = 0;
        const push = (chunk: Buffer): void => { pending.push(chunk); pendingBytes += chunk.length; };
        const take = (): Buffer => {
          const out = Buffer.concat(pending, pendingBytes);
          pending = [];
          pendingBytes = 0;
          return out;
        };
        push(Buffer.concat(headerBytes));
        let last = false;
        while (!last) {
          const header = (await read(3)).readUIntLE(0, 3);
          last = (header & 1) !== 0;
          const type = (header >>> 1) & 3;
          const blockSize = header >>> 3;
          if (type === 3 || blockSize > 131072) throw new Error('Invalid Zstandard block');
          const payload = type === 1 ? 1 : blockSize;
          if (offset + payload > size || offset + payload - start > MAX_FRAME) throw new Error('Invalid or oversized Zstandard frame');
          push(Buffer.from([header & 0xff, (header >>> 8) & 0xff, (header >>> 16) & 0xff]));
          let remaining = payload;
          while (remaining > 0) {
            const chunk = await read(Math.min(remaining, WRITE_CHUNK));
            remaining -= chunk.length;
            push(Buffer.from(chunk));
            if (pendingBytes >= WRITE_CHUNK) yield take();
          }
          if (pendingBytes >= WRITE_CHUNK) yield take();
        }
        if (descriptor & 4) push(Buffer.from(await read(4)));
        if (offset - start > MAX_FRAME) throw new Error('Oversized Zstandard frame');
        if (pendingBytes > 0) yield take();
      };
      const raw = Readable.from(feed());
      const decoder = createZstdDecompress({ params: { [constants.ZSTD_d_windowLogMax]: 27 } });
      raw.on('error', (error) => decoder.destroy(error));
      raw.pipe(decoder);
      let output = 0;
      try {
        for await (const chunk of decoder) {
          output += (chunk as Buffer).length;
          if (output > MAX_OUTPUT) throw new Error('Zstandard frame output exceeds limit');
          yield chunk as Buffer;
        }
      } finally {
        raw.destroy();
        decoder.destroy();
      }
    }
  } catch (error) {
    if (!signal?.aborted) throw error;
  } finally {
    await handle.close();
  }
}
