/**
 * 测试价值
 * - 生产入口与可观察结果：readGhostReadmeFromDir(详情页 IPC、自定义市场与手机详情共用)返回的正文与图片表。
 * - 规则依据：plugin-security-and-authoring §4(包内文件逐段拒链接、限量读);产品决定「只显示包内图片」。
 * - 现有覆盖缺口：新模块；图标与语言资源的读取测试不覆盖介绍正文引用的图片。
 * - 最小失败输入：图片是指向包外文件的符号链接 / 正文引用外部地址 / 缺少当前语言。
 * - tier：unit(真实临时目录，无网络)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GhostManifest } from '../../../shared/ghost';
import { readGhostReadmeFromDir } from '../ghostReadme';

let root: string;

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-ghost-readme-'));
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

async function write(rel: string, content: string | Buffer) {
  const abs = path.join(root, 'plugin', rel);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, content);
}

// 能力探测而不是按平台跳过(engineering-conventions §3.2「平台能力差异」):能建符号链接的平台都实跑。
const canSymlink = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-readme-symlink-probe-'));
  try {
    fs.writeFileSync(path.join(dir, 'target.txt'), 'probe');
    fs.symlinkSync(path.join(dir, 'target.txt'), path.join(dir, 'link.txt'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

const manifest = {
  readme: { en: 'README.md', 'zh-CN': 'docs/README.zh-CN.md' },
} as unknown as GhostManifest;

describe('readGhostReadmeFromDir', () => {
  it('picks the UI language, falls back to English and returns only package images', async () => {
    await write('README.md', '# Demo\n![shot](assets/shot.png) ![remote](https://example.com/x.png)');
    await write('docs/README.zh-CN.md', '# 演示\n![图](../assets/shot.png)');
    await write('assets/shot.png', Buffer.from('png-bytes'));
    const dir = path.join(root, 'plugin');

    const zh = await readGhostReadmeFromDir(dir, manifest, 'zh-CN');
    expect(zh).toEqual({
      path: 'docs/README.zh-CN.md',
      markdown: '# 演示\n![图](../assets/shot.png)',
      images: { 'assets/shot.png': `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}` },
    });
    const ja = await readGhostReadmeFromDir(dir, manifest, 'ja');
    expect(ja?.path).toBe('README.md');
    expect(Object.keys(ja?.images ?? {})).toEqual(['assets/shot.png']);
  });

  it.skipIf(!canSymlink)('does not read an image that links outside the plugin', async () => {
    const secret = path.join(root, 'secret.png');
    await fs.promises.writeFile(secret, 'outside');
    await write('README.md', '![leak](assets/leak.png)');
    await fs.promises.mkdir(path.join(root, 'plugin', 'assets'), { recursive: true });
    await fs.promises.symlink(secret, path.join(root, 'plugin', 'assets', 'leak.png'));

    const readme = await readGhostReadmeFromDir(path.join(root, 'plugin'), manifest, 'en');
    expect(readme?.images).toEqual({});
  });
});
