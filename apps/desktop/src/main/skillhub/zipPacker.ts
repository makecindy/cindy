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

/**
 * zip 条目时间戳固定为常量 UTC 瞬间:JSZip 缺省给每个条目盖打包瞬间的墙钟
 * (DOS 时间 2 秒精度),同一内容两次打包跨过秒界 sha256 即漂移——"内容相同 ⇒
 * 包字节相同"的确定性契约破产(publish 重试缓存与 server 端校验都以包 sha
 * 为锚,CI 上 determinism 用例也会随机红)。
 *
 * 时区无关性:本仓 JSZip 3.10 写 DOS 字段用的是 **UTC getters**
 * (generate/ZipFileWorker.js: getUTCHours / getUTCFullYear),固定 UTC 瞬间
 * 在任何进程时区下写出的字节都相同;回归用例用 TZ 翻转锁住这一点,若未来
 * 升级 JSZip 改回本地 getters,该用例会红。(zip DOS 时间下限 1980,不能用
 * Unix epoch;条目真实 mtime 本就不进 manifest,无信息损失。)
 */
const ZIP_ENTRY_DATE = new Date(Date.UTC(2020, 0, 1));

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
    // createFolders: false —— JSZip 缺省会为子目录隐式生成文件夹条目,且该条目
    // 盖打包瞬间墙钟(date 选项只作用于本文件),确定性再度破口;省略文件夹条目
    // 是可复现打包的标准做法,解压工具一律按文件路径自建目录,语义无损。
    zip.file(relPath, content, { date: ZIP_ENTRY_DATE, createFolders: false });

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
