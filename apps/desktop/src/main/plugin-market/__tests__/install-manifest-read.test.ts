/**
 * installCustomMarketPlugin — 安装前置的身份卡读取必须走限量句柄闸。
 * 详情展示后、确认安装前,本地市场目录仍是用户可写的活目录;按路径无界
 * readFile 会被换成超大文件或符号链接绕过发现层的闸。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()) },
}));

const brain = vi.hoisted(() => ({
  installOrUpdateMarketGhostPackage: vi.fn(async () => ({}) as never),
  rejectReservedGhostIdForCustomMarket: vi.fn(),
  packGhostDirToFile: vi.fn(async () => ({ ok: true as const, manifest: {} })),
}));
vi.mock('../../cindy-brain/index.js', () => ({
  installOrUpdateMarketGhostPackage: brain.installOrUpdateMarketGhostPackage,
  rejectReservedGhostIdForCustomMarket: brain.rejectReservedGhostIdForCustomMarket,
}));
vi.mock('../../cindy-brain/forge.js', () => ({
  packGhostDirToFile: brain.packGhostDirToFile,
}));
const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../../logger.js', () => ({ createLogger: () => logger }));

import type { GhostManifest } from '../../../shared/ghost.js';
import { installCustomMarketPlugin } from '../install';

const GOOD_MANIFEST = {
  schemaVersion: 2,
  id: 'demo',
  name: '演示插件',
  version: '1.0.0',
  kind: 'chip',
  entry: 'main.js',
  slots: ['tool'],
  tools: [{ name: 'do_thing', description: '做点事' }],
};

let workDir: string;

beforeEach(async () => {
  workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-market-install-'));
  brain.packGhostDirToFile.mockClear();
  logger.warn.mockClear();
});

afterEach(async () => {
  await fs.promises.rm(workDir, { recursive: true, force: true });
});

describe('installCustomMarketPlugin · 身份卡读取闸', () => {
  it.runIf(process.platform !== 'win32')(
    'ghost.json 为符号链接 → GHOST_FILE_INVALID,不进入打包',
    async () => {
      // 目标是合法清单也不放行:发现层拒链接,安装层跟随链接就等于绕闸。
      const outside = path.join(workDir, 'outside-ghost.json');
      await fs.promises.writeFile(outside, JSON.stringify(GOOD_MANIFEST));
      const pluginDir = path.join(workDir, 'plugin');
      await fs.promises.mkdir(pluginDir, { recursive: true });
      await fs.promises.symlink(outside, path.join(pluginDir, 'ghost.json'));

      await expect(
        installCustomMarketPlugin({
          pluginDir,
          expected: GOOD_MANIFEST as unknown as GhostManifest,
        }),
      ).rejects.toMatchObject({ code: 'GHOST_FILE_INVALID' });
      expect(brain.packGhostDirToFile).not.toHaveBeenCalled();
    },
  );

  it('ghost.json 超过 512 KiB → GHOST_FILE_INVALID,不进入打包', async () => {
    // JSON 本身合法(合法清单 + 尾随空白撑体积):必须在读取层按大小拒,
    // 不能等 parse/validate——那时超大文件已经整个进内存了。
    const pluginDir = path.join(workDir, 'plugin-big');
    await fs.promises.mkdir(pluginDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(pluginDir, 'ghost.json'),
      JSON.stringify(GOOD_MANIFEST) + ' '.repeat(600 * 1024),
    );

    await expect(
      installCustomMarketPlugin({
        pluginDir,
        expected: GOOD_MANIFEST as unknown as GhostManifest,
      }),
    ).rejects.toMatchObject({ code: 'GHOST_FILE_INVALID' });
    expect(brain.packGhostDirToFile).not.toHaveBeenCalled();
  });

  it('把已校验的规范根同时作为打包输入与打包器锚点传下去', async () => {
    // 契约用例:锚点必须是**本层校验过的那个规范根**,不能是任何别的字符串
    // (第三个参数是必填的,TS 只能保证"传了",保证不了"传对";传成 tempPath
    // 之类会让打包器的锚点校验永远失败或永远通过,这里咬住)。
    // "被换成外部链接"本身由两处防线拦:本层的等值校验 + 打包器内的锚点校验
    // (各有独立用例)。
    const pluginDir = path.join(workDir, 'plugin-ok');
    await fs.promises.mkdir(pluginDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(pluginDir, 'ghost.json'),
      JSON.stringify(GOOD_MANIFEST),
    );
    const canonical = await fs.promises.realpath(pluginDir);
    brain.packGhostDirToFile.mockResolvedValue({
      ok: true as const,
      manifest: GOOD_MANIFEST,
    });

    await installCustomMarketPlugin({
      pluginDir: canonical,
      expected: GOOD_MANIFEST as unknown as GhostManifest,
    });

    expect(brain.packGhostDirToFile).toHaveBeenCalledWith(
      canonical,
      expect.stringContaining('.cindy'),
      canonical, // ← 锚点必须是上游校验过的规范根
    );
  });

  it.runIf(process.platform !== 'win32')(
    '发现后插件目录被换成指向市场外的符号链接 → 拒绝,不进入打包',
    async () => {
      // 发现层交回的是已 realpath、已校验在根内的规范路径。之后把该目录换成指向
      // 市场外(留着同样的 ghost.json)的符号链接:重解析落到别处,清单摘要复核
      // 发现不了。install 必须发现 realpath 已改变并拒绝,payload 不被打包。
      const outside = path.join(workDir, 'outside');
      await fs.promises.mkdir(outside, { recursive: true });
      await fs.promises.writeFile(
        path.join(outside, 'ghost.json'),
        JSON.stringify(GOOD_MANIFEST),
      );
      const realParent = path.join(workDir, 'market');
      await fs.promises.mkdir(realParent, { recursive: true });
      const realPluginDir = path.join(realParent, 'alpha');
      await fs.promises.mkdir(realPluginDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(realPluginDir, 'ghost.json'),
        JSON.stringify(GOOD_MANIFEST),
      );
      // 发现时的规范路径(realpath 幂等)。
      const discovered = await fs.promises.realpath(realPluginDir);
      // 攻击:把 alpha 换成指向 outside 的符号链接。
      await fs.promises.rm(realPluginDir, { recursive: true, force: true });
      await fs.promises.symlink(outside, realPluginDir);

      await expect(
        installCustomMarketPlugin({
          pluginDir: discovered, // 传发现时的规范路径
          expected: GOOD_MANIFEST as unknown as GhostManifest,
        }),
      ).rejects.toMatchObject({
        code: 'GHOST_FILE_INVALID',
        // 专用原因不得被下面那个通用 catch 的 "manifest missing or unreadable"
        // 覆盖:事后排查要能区分"有人中途替换了目录"与"文件确实损坏"。
        message: expect.stringContaining('changed after discovery'),
      });
      expect(brain.packGhostDirToFile).not.toHaveBeenCalled();
    },
  );

  it('清单确实损坏 → 通用文案给 Renderer,原始原因留 main 日志', async () => {
    // Renderer 只该拿到不泄露宿主细节的通用文案,但 main 日志必须留下原因,
    // 否则"损坏"与"被替换"两种情况在日志里完全一样,排查无从下手。
    const pluginDir = path.join(workDir, 'plugin-broken');
    await fs.promises.mkdir(pluginDir, { recursive: true });
    await fs.promises.writeFile(path.join(pluginDir, 'ghost.json'), '{not json');

    await expect(
      installCustomMarketPlugin({
        pluginDir: await fs.promises.realpath(pluginDir),
        expected: GOOD_MANIFEST as unknown as GhostManifest,
      }),
    ).rejects.toMatchObject({
      code: 'GHOST_FILE_INVALID',
      message: expect.stringContaining('missing or unreadable'),
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'custom market plugin manifest unreadable',
      expect.objectContaining({ detail: expect.stringMatching(/JSON|token|Unexpected/i) }),
    );
  });

  it('结构守卫:install.ts 不允许出现按路径的 readFile', async () => {
    // 发现/安装/打包三条链路都必须走 readBoundedFileNoFollow;任何一处退回
    // fs.promises.readFile(path) 都会重开"检查与读取两次打开"的替换窗口。
    const source = await fs.promises.readFile(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'install.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/readFile\(/);
    expect(source).toContain('readBoundedFileNoFollow');
  });
});
