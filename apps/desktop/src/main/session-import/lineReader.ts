/**
 * 流式按行读取来源历史，透明支持 zstd 压缩（`.zst`）。
 *
 * Codex 会把 7 天前的历史压缩成 `.jsonl.zst`，DeepSeek Harness 默认也写 zstd 帧；
 * 读取统一走这里，内存只和最长一行有关，200 MB 以上的历史同样逐行处理。
 */

import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import readline from 'node:readline';
import { createZstdDecompress } from 'node:zlib';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export function isZstdPath(file: string): boolean {
  return file.endsWith('.zst') || file.endsWith('.zstd');
}

export interface LineReadOptions {
  signal?: AbortSignal;
  /** 每读到一块原始（压缩前）字节回调一次。 */
  onBytes?: (bytes: number) => void;
  /** 只读文件头部的原始字节上限（扫描摘要用）；压缩文件按解压后的字节计。 */
  maxBytes?: number;
}

function openText(file: string, opts: LineReadOptions): { stream: Readable; close: () => void } {
  const raw = createReadStream(file, isZstdPath(file) || opts.maxBytes === undefined ? {} : { end: opts.maxBytes - 1 });
  if (opts.onBytes) raw.on('data', (chunk: Buffer | string) => opts.onBytes?.(chunk.length));
  if (!isZstdPath(file)) {
    raw.setEncoding('utf-8');
    return { stream: raw, close: () => raw.destroy() };
  }
  const zstd = createZstdDecompress();
  raw.on('error', (err) => zstd.destroy(err));
  raw.pipe(zstd);
  zstd.setEncoding('utf-8');
  return {
    stream: zstd,
    close: () => {
      raw.destroy();
      zstd.destroy();
    },
  };
}

/** 逐行产出（不含换行符）。读到 maxBytes 或 signal 中止时提前结束。 */
export async function* readLines(file: string, opts: LineReadOptions = {}): AsyncGenerator<string> {
  const { stream, close } = openText(file, opts);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let seen = 0;
  try {
    for await (const line of rl) {
      if (opts.signal?.aborted) return;
      seen += Buffer.byteLength(line) + 1;
      yield line;
      if (opts.maxBytes !== undefined && isZstdPath(file) && seen >= opts.maxBytes) return;
    }
  } finally {
    rl.close();
    close();
  }
}

/** 读取第一行（session 头），读不到返回 null。 */
export async function readFirstLine(file: string, maxBytes = 2 * 1024 * 1024): Promise<string | null> {
  for await (const line of readLines(file, { maxBytes })) {
    if (line.trim()) return line;
  }
  return null;
}

export function parseJsonLine(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 解压整个 zstd 文件到目标路径（流式，不整体载入内存）。 */
export async function decompressZstdFile(source: string, target: string): Promise<void> {
  await pipeline(createReadStream(source), createZstdDecompress(), createWriteStream(target, { flags: 'wx', mode: 0o600 }));
}

export async function statSize(file: string): Promise<number> {
  const stat = await fsp.stat(file).catch(() => null);
  return stat?.size ?? 0;
}
