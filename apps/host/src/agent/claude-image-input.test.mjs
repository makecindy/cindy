/*
 * 测试价值
 * - 生产入口：ImageResizer.validateBuffer / toClaudeSdkContent；合法图片必须成为
 *   Claude 图片块，不能因 sharp 加载失败退回 @路径文本。
 * - Bug：main 在未打包 Node ESM 下用 eval('require') 加载 sharp，异常被吞掉。
 * - 覆盖缺口：现有 Vitest 用例不使用 Node Host 的原生 ESM 加载链；其他 Host
 *   Claude 测试构建整个 agent graph，既不覆盖附件转换，又有不必要的初始化成本。
 * - 最小输入：一张 64×64 RGB PNG。tier：unit，无网络、子进程或真实等待。
 * - 独立文件原因：专门保护 ESM 加载边界，必须由 Host 原有 node:test + tsx/raw
 *   加载器运行；不 mock sharp、resizer 或图片转换入口。
 * - 实测：同 Host 的 node --import tsx --import ./src/loaders/register-raw.mjs
 *   --test 命令，单文件约 0.47 秒；用例执行约 7ms。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { URL } from 'node:url';

import { ImageResizer } from '../../../../packages/maker-core/src/agents/shared/image-resizer.ts';
import { toClaudeSdkContent } from '@cindy/maker-core/agents/claude-code';

// Resolve the optional peer from its owning package, just as the Host does.
const sharp = createRequire(new URL('../../../../packages/maker-core/package.json', import.meta.url))('sharp');

test('Node ESM validates a PNG and sends a native Claude image block instead of a path', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cindy-host-image-esm-'));
  const resizer = new ImageResizer({ cacheDir: path.join(root, 'cache') });
  t.after(async () => {
    await resizer.process(''); // Join cache initialization even if validation failed.
    await rm(root, { recursive: true, force: true });
  });
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#456789' } })
    .png({ compressionLevel: 0 }).toBuffer();
  const imagePath = path.join(root, 'image.png');
  await writeFile(imagePath, png);

  assert.equal(await resizer.validateBuffer(png), true);
  // Pass the real resizer; only its cache directory differs from Host defaults.
  const content = await toClaudeSdkContent([{ type: 'image', path: imagePath }], resizer);
  assert.ok(Array.isArray(content), 'valid PNG must not fall back to an @path string');
  assert.deepEqual(content, [{
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') },
  }]);
});
