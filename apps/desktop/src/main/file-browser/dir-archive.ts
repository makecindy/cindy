/**
 * dir-archive — 远程文件夹下载的打包 / 解包(被控端打包,控制端解包)。
 *
 * 用 tar 而不是逐个文件取回:.app 这类程序包依赖符号链接与可执行位,逐个文件
 * 拷贝会丢掉它们,下载下来的 app 打不开。打包不压缩(大文件夹多为已压缩的二进制,
 * gzip 只会拖慢),不跟随符号链接,只保留可移植的元数据。
 *
 * 解包的安全边界:
 *  - preservePaths=false:tar 自己拒绝绝对路径与 `..` 段;
 *  - 符号链接一律推迟到所有文件、目录写完后再建,建之前确认父目录真身仍在目标
 *    目录内——任何条目都不会经由符号链接写到目标目录之外;
 *  - 单个条目写不出来(权限、Windows 上无法建符号链接、特殊文件)只跳过并计数,
 *    不让整次下载失败。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';

/** 打包整个目录(条目以 `./` 为根)。onSkip 在单个条目读不出时调用,打包继续。 */
export function packDirectory(dir: string, onSkip: () => void): Readable {
  return tar.c({ cwd: dir, portable: true, follow: false, strict: false, onwarn: () => onSkip() }, [
    '.',
  ]) as unknown as Readable;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 把 tar 流解到 `dest`(必须已存在且为空)。返回跳过的条目数。
 * 流本身损坏(截断、格式错误)时 reject。
 */
export async function extractDirectoryArchive(input: Readable, dest: string): Promise<number> {
  const root = await fsp.realpath(dest);
  const links: Array<{ name: string; target: string }> = [];
  let skipped = 0;
  await pipeline(
    input,
    tar.x({
      cwd: root,
      strict: false,
      preservePaths: false,
      onwarn: () => {
        skipped++;
      },
      filter: (name, entry) => {
        if ('type' in entry && entry.type === 'SymbolicLink') {
          links.push({ name, target: entry.linkpath ?? '' });
          return false;
        }
        return true;
      },
    }) as unknown as NodeJS.WritableStream,
  );
  for (const link of links) {
    try {
      const normalized = path.normalize(link.name);
      if (!link.target || path.isAbsolute(normalized) || normalized.split(path.sep).includes('..'))
        throw new Error('unsafe link');
      const at = path.join(root, normalized);
      // 父目录可能本身就是先建好的符号链接:取真身确认仍在目标目录内再建。
      if (!isInside(root, await fsp.realpath(path.dirname(at)))) throw new Error('unsafe link');
      await fsp.symlink(link.target, at);
    } catch {
      skipped++;
    }
  }
  return skipped;
}
