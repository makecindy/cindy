/**
 * skillhub/zipPacker.ts — skill 目录打 zip (F-pub-5, M3)
 *
 * 使用 jszip 全内存打包（skill < 10MB 产品红线）。
 * 排除规则与 folderHash 完全一致（明确高风险 / 平台噪声路径），
 * 否则 hash 与 manifest 会对不上。
 *
 * zip 根直接是 SKILL.md（不带顶层目录），方便 server 端解压检视。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';

import { createLogger } from '../logger';
import { isIgnoredSkillPackagePath } from './packageIgnore';

const log = createLogger('skillhub:zipPacker');

// ── Types ────────────────────────────────────────────────────────────────────

export interface PackResult {
  buffer: Buffer;
  sha256: string;
  size: number;
  manifest: {
    files: Array<{ relPath: string; size: number; sha256: string }>;
  };
}

export interface PackOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
}

export class PackCancelledError extends Error {
  constructor() {
    super('已取消');
    this.name = 'PackCancelledError';
  }
}

export class PackTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`打包超过 ${Math.ceil(timeoutMs / 1000)} 秒未完成，请重试`);
    this.name = 'PackTimeoutError';
  }
}

function createPackGuard(options: PackOptions): () => void {
  const startedAt = (options.now ?? Date.now)();
  return () => {
    if (options.signal?.aborted) {
      throw new PackCancelledError();
    }
    if (options.timeoutMs !== undefined && (options.now ?? Date.now)() - startedAt > options.timeoutMs) {
      throw new PackTimeoutError(options.timeoutMs);
    }
  };
}

// ── sha256 辅助 ──────────────────────────────────────────────────────────────

function bufferSha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function streamSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

// ── walk 递归 ────────────────────────────────────────────────────────────────

async function walk(
  zip: JSZip,
  dir: string,
  rootDir: string,
  manifest: PackResult['manifest'],
  checkPackState: () => void,
): Promise<void> {
  checkPackState();
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const e of entries) {
    checkPackState();
    const fullPath = path.join(dir, e.name);
    const relPath = path.relative(rootDir, fullPath).split(path.sep).join('/');
    if (isIgnoredSkillPackagePath(relPath)) continue;

    if (e.isDirectory()) {
      await walk(zip, fullPath, rootDir, manifest, checkPackState);
      continue;
    }
    if (!e.isFile()) continue;

    const content = await fs.promises.readFile(fullPath);
    checkPackState();
    zip.file(relPath, content);

    const fileSha256 = await streamSha256(fullPath);
    checkPackState();
    manifest.files.push({
      relPath,
      size: content.length,
      sha256: fileSha256,
    });
  }
}

// ── 公开 API ─────────────────────────────────────────────────────────────────

export async function pack(absolutePath: string, options: PackOptions = {}): Promise<PackResult> {
  const zip = new JSZip();
  const manifest: PackResult['manifest'] = { files: [] };
  const checkPackState = createPackGuard(options);

  await walk(zip, absolutePath, absolutePath, manifest, checkPackState);

  // 按 relPath 排序 manifest，保持确定性
  manifest.files.sort((a, b) => a.relPath.localeCompare(b.relPath));

  checkPackState();
  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  }, () => {
    checkPackState();
  });
  checkPackState();

  const sha256 = bufferSha256(buffer);

  // 调试用:打印 zip 内容清单 + 总字节,便于核对"我没改 skill 但 dirty"等问题
  log.info(
    `[zipPacker] absolutePath=${absolutePath}\n` +
      `  fileCount=${manifest.files.length}  zipSize=${buffer.length}B  zipSha256=${sha256.slice(0, 16)}...\n` +
      `  files:\n${manifest.files
        .map((f) => `    ${f.relPath}  ${f.size}B  ${f.sha256.slice(0, 16)}...`)
        .join('\n')}`,
  );

  return {
    buffer,
    size: buffer.length,
    sha256,
    manifest,
  };
}
