/** Stream independently appended Zstandard frames through Node's checksum-validating decoder. */
import { createReadStream, promises as fs } from 'node:fs';
import { createZstdDecompress, constants } from 'node:zlib';

const MAX_FRAME = 1024 * 1024 * 1024;
const MAX_OUTPUT = 1024 * 1024 * 1024;

export async function* readZstdFrames(file: string, onBytes?: (bytes: number) => void): AsyncGenerator<Buffer> {
  const handle = await fs.open(file, 'r');
  let size: number;
  try {
    size = (await handle.stat()).size;
  } catch (error) {
    await handle.close();
    throw error;
  }
  let offset = 0;
  const read = async (count: number): Promise<Buffer> => {
    if (count < 0 || offset + count > size) throw new Error('Truncated Zstandard frame');
    const result = Buffer.alloc(count);
    const { bytesRead } = await handle.read(result, 0, count, offset);
    if (bytesRead !== count) throw new Error('Truncated Zstandard frame');
    offset += count;
    return result;
  };
  try {
    while (offset < size) {
      const start = offset;
      const magic = (await read(4)).readUInt32LE();
      if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
        const length = (await read(4)).readUInt32LE();
        if (length > MAX_FRAME || offset + length > size) throw new Error('Invalid Zstandard skippable frame');
        offset += length;
        continue;
      }
      if (magic !== 0xfd2fb528) throw new Error('Invalid Zstandard frame magic');
      const descriptor = (await read(1))[0]!;
      if (descriptor & 0x18) throw new Error('Invalid Zstandard frame descriptor');
      const single = (descriptor & 0x20) !== 0;
      if (!single) await read(1); // window descriptor, validated by the native decoder
      const dictionaryFlag = descriptor & 3;
      const contentFlag = descriptor >>> 6;
      const dictionarySize = [0, 1, 2, 4][dictionaryFlag]!;
      const contentSize = contentFlag === 0 ? (single ? 1 : 0) : 1 << contentFlag;
      await read(dictionarySize + contentSize);
      let last = false;
      while (!last) {
        const block = await read(3);
        const header = block.readUIntLE(0, 3);
        last = (header & 1) !== 0;
        const type = (header >>> 1) & 3;
        const blockSize = header >>> 3;
        if (type === 3 || blockSize > 131072) throw new Error('Invalid Zstandard block');
        const payload = type === 1 ? 1 : blockSize;
        if (offset + payload > size || offset + payload - start > MAX_FRAME) throw new Error('Invalid or oversized Zstandard frame');
        offset += payload;
      }
      if (descriptor & 4) await read(4);
      if (offset - start > MAX_FRAME) throw new Error('Oversized Zstandard frame');
      const raw = createReadStream(file, { start, end: offset - 1 });
      if (onBytes) raw.on('data', (chunk) => onBytes(chunk.length));
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
  } finally {
    await handle.close();
  }
}
