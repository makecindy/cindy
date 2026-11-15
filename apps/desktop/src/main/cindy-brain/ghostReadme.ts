/**
 * 插件详细介绍（manifest.readme）的读取：从插件目录（已安装目录或自定义市场的
 * 本地副本）按语言读出 Markdown，并把正文引用的包内图片转成 data URL。
 * 只在打开详情页时按需读取，不随插件列表广播；内容只给界面，不进模型上下文。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  collectGhostReadmeImagePaths,
  ghostIconMimeType,
  GHOST_README_IMAGE_MAX_BYTES,
  GHOST_README_IMAGES_MAX_TOTAL_BYTES,
  GHOST_README_MAX_BYTES,
  GHOST_README_MAX_IMAGES,
  type GhostReadmeContent,
} from '@cindy/plugin-protocol';

import { ghostReadmePathFor, type GhostManifest } from '../../shared/ghost.js';
import { readBoundedFileNoFollow } from '../utils/readBoundedFile.js';
import { resolveGhostContentPath } from './ghostContentTree.js';

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * 读不到、超限、不是合法 UTF-8 或正文为空时返回 null（详情页不显示介绍区）。
 * 单张图片缺失或超限只跳过该图；数量与总量按正文出现顺序截止。
 */
export async function readGhostReadmeFromDir(
  dir: string,
  manifest: GhostManifest,
  locale: string | null | undefined,
): Promise<GhostReadmeContent | null> {
  const readmePath = ghostReadmePathFor(manifest, locale);
  if (!readmePath) return null;
  let root: string;
  try {
    root = await fs.promises.realpath(dir);
  } catch {
    return null;
  }
  const markdownBytes = await readPackageFile(dir, root, readmePath, GHOST_README_MAX_BYTES);
  if (!markdownBytes) return null;
  let markdown: string;
  try {
    markdown = utf8.decode(markdownBytes).replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
  if (markdown.trim().length === 0) return null;

  const images: Record<string, string> = {};
  let count = 0;
  let totalBytes = 0;
  for (const imagePath of collectGhostReadmeImagePaths(markdown, readmePath)) {
    if (count >= GHOST_README_MAX_IMAGES) break;
    const mime = ghostIconMimeType(imagePath);
    if (!mime) continue;
    const bytes = await readPackageFile(dir, root, imagePath, GHOST_README_IMAGE_MAX_BYTES);
    if (!bytes || totalBytes + bytes.length > GHOST_README_IMAGES_MAX_TOTAL_BYTES) continue;
    images[imagePath] = `data:${mime};base64,${bytes.toString('base64')}`;
    count += 1;
    totalBytes += bytes.length;
  }
  return { path: readmePath, markdown, images };
}

/** 逐段拒绝链接解析 + 单句柄限量读，判据与图标、语言资源同源。 */
async function readPackageFile(
  dir: string,
  root: string,
  relPath: string,
  maxBytes: number,
): Promise<Buffer | null> {
  try {
    const absPath = await resolveGhostContentPath(dir, relPath, {
      expect: 'file',
      label: 'ghost readme',
    });
    return await readBoundedFileNoFollow(absPath, maxBytes, {
      containWithin: root,
      nonBlocking: true,
      rejectHardLinks: true,
    });
  } catch {
    return null;
  }
}

/**
 * 打包期检查（Forge）：声明的每份介绍必须在场、不超限且是 UTF-8；正文里作为 Markdown 图片
 * 引用的包内图片（与运行时读取同一份收集结果）必须在场，且逐张大小、张数与总量不超限。
 * 返回第一条问题，没有问题返回 null。外部图片地址不报错（运行时不显示）。
 */
export async function checkGhostReadmeForPack(
  dir: string,
  manifest: GhostManifest,
): Promise<string | null> {
  if (!manifest.readme) return null;
  const root = await fs.promises.realpath(dir);
  for (const readmePath of new Set(Object.values(manifest.readme))) {
    const bytes = await readPackageFile(dir, root, readmePath, GHOST_README_MAX_BYTES);
    if (!bytes) {
      return `详细介绍 ${readmePath} 不存在、不是普通文件或超过 ${GHOST_README_MAX_BYTES} 字节上限`;
    }
    let markdown: string;
    try {
      markdown = utf8.decode(bytes);
    } catch {
      return `详细介绍 ${readmePath} 必须是 UTF-8 文本`;
    }
    let count = 0;
    let totalBytes = 0;
    for (const imagePath of collectGhostReadmeImagePaths(markdown, readmePath)) {
      let size: number;
      try {
        const stat = await fs.promises.lstat(path.join(dir, ...imagePath.split('/')));
        if (!stat.isFile()) throw new Error('not a file');
        size = stat.size;
      } catch {
        return `详细介绍 ${readmePath} 引用的图片不存在:${imagePath}`;
      }
      if (size > GHOST_README_IMAGE_MAX_BYTES) {
        return `详细介绍图片 ${imagePath} 超过 ${GHOST_README_IMAGE_MAX_BYTES} 字节上限`;
      }
      count += 1;
      totalBytes += size;
      if (count > GHOST_README_MAX_IMAGES) {
        return `详细介绍 ${readmePath} 引用的图片超过 ${GHOST_README_MAX_IMAGES} 张`;
      }
      if (totalBytes > GHOST_README_IMAGES_MAX_TOTAL_BYTES) {
        return `详细介绍 ${readmePath} 的图片合计超过 ${GHOST_README_IMAGES_MAX_TOTAL_BYTES} 字节上限`;
      }
    }
  }
  return null;
}
