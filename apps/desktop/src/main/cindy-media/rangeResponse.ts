/**
 * rangeResponse.ts — cindy 系媒体协议的 Range/206 响应组装(视频播放支持)。
 * ---------------------------------------------------------------------------
 * <video>/<audio> 元素靠 Range 请求做分片加载与 seek:协议只回整段 200、
 * 不带 Accept-Ranges 时,Chromium 的媒体管线直接黑屏——这正是 cindy-media://
 * 只服务图片时留下的欠账(本文件头注释当年写着"视频 Range 待补")。
 *
 * 模式与 xdt-video / xdt-audio 的手动 206 同款(scheme privilege 保持
 * stream:false);Range 解析复用 audioFileProtocol.parseRangeHeader(纯函数,
 * 已有测试),不再抄第三份。图片请求不带 Range 头 → 原样走 200 分支,行为不变。
 */

import { parseRangeHeader } from '../audioFileProtocol.js';
import type { FileHandle } from 'node:fs/promises';
import { addAbortSignal, Readable } from 'node:stream';

/** Buffer → 独立 ArrayBuffer(Response 不接受共享底层的偏移视图)。 */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/**
 * 按 Range 头组装 416 / 206 / 200 三态响应。
 * cacheControl 由调用方给(内容寻址地址可 immutable 长缓存)。
 */
export function buildRangedMediaResponse(params: {
  buffer: Buffer;
  mimeType: string;
  rangeHeader: string | null;
  cacheControl: string;
}): Response {
  const { buffer, mimeType, rangeHeader, cacheControl } = params;
  const totalSize = buffer.byteLength;
  const range = parseRangeHeader(rangeHeader, totalSize);

  if (range && range.kind === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: {
        'Content-Type': mimeType,
        'Content-Range': `bytes */${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': cacheControl,
      },
    });
  }

  if (range && range.kind === 'range') {
    const slice = buffer.subarray(range.start, range.end + 1);
    return new Response(toArrayBuffer(slice), {
      status: 206,
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(slice.byteLength),
        'Content-Range': `bytes ${range.start}-${range.end}/${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': cacheControl,
      },
    });
  }

  return new Response(toArrayBuffer(buffer), {
    status: 200,
    headers: {
      'Content-Type': mimeType,
      'Content-Length': String(totalSize),
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheControl,
    },
  });
}

/** Consume an already verified file handle, streaming only the selected bytes. */
export async function buildRangedFileResponse(params: {
  file: FileHandle;
  totalSize: number;
  mimeType: string;
  rangeHeader: string | null;
  cacheControl: string;
  signal: AbortSignal;
}): Promise<Response> {
  const { file, totalSize, mimeType, rangeHeader, cacheControl, signal } = params;
  try {
    const range = parseRangeHeader(rangeHeader, totalSize);
    const headers: Record<string, string> = {
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheControl,
    };
    if (range?.kind === 'unsatisfiable') {
      await file.close();
      return new Response(null, {
        status: 416,
        headers: { ...headers, 'Content-Range': `bytes */${totalSize}` },
      });
    }
    const start = range?.kind === 'range' ? range.start : 0;
    const end = range?.kind === 'range' ? range.end : totalSize - 1;
    headers['Content-Length'] = String(end - start + 1);
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${totalSize}`;
    if (totalSize === 0) {
      await file.close();
      return new Response(null, { status: 200, headers });
    }
    // Both queues are byte-bounded. toWeb's default counts chunks, which could
    // otherwise buffer thousands of 64 KiB chunks from an open-ended Range.
    // autoClose handles EOF/errors; web cancellation and request abort destroy it.
    const stream = file.createReadStream({ start, end, highWaterMark: 64 * 1024 });
    const body = Readable.toWeb(stream, {
      strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength },
    });
    // Attach cancellation only after toWeb installed its error listener, including
    // when the request was already aborted while opening the file.
    addAbortSignal(signal, stream);
    return new Response(body as ReadableStream<Uint8Array>, {
      status: range ? 206 : 200,
      headers,
    });
  } catch (error) {
    await file.close();
    throw error;
  }
}
