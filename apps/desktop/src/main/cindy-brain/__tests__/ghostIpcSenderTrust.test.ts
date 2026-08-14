import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 源码契约测试:所有会改写插件世界(装/卸/更/启停/导出/恢复内置)或发放
 * 装入票据的高权限 ghost IPC,handler 体内必须调用 assertTrustedAppRendererEvent,
 * 按 Electron 持有的真实顶层 frame 判定来源。
 *
 * 背景:Renderer / WebView / Ghost 页面都是不可信输入(见 trustedAppRenderer.ts)。
 * 卸载会停运行时、撤 receipt 批准、清凭证/KV/ghost-fs 并删安装目录;恢复内置会清
 * 墓碑触发对账装回 —— 这些通道若忽略 event(用 `_event`),不受信页面 invoke 即可
 * 卸载/改写任意插件。第 9 轮 integration review 实锤 ghosts:uninstall 与
 * ghosts:restore-builtin 漏了这道闸。
 *
 * index.ts 拉起整张 main 进程单例图,handler 无法脱离 electron 直测,所以沿用
 * 与 ghostIpcMutationLease.test.ts 相同的源码扫描钉契约:新增高权限写路径时把
 * channel 加进清单;想去掉断言必须先改掉"页面不可信"这个前提。
 */

const TRUSTED_SENDER_CHANNELS = [
  'ghosts:install',
  'ghosts:update',
  'ghosts:inspect',
  'ghosts:uninstall',
  'ghosts:export',
  'ghosts:set-enabled',
  'ghosts:restore-builtin',
  'ghosts:reapprove-inspect',
  'ghosts:reapprove-installed',
] as const;

function handlerBlock(source: string, channel: string): string {
  const start = source.indexOf(`ipcMain.handle('${channel}'`);
  expect(start, `handler for ${channel} not found`).toBeGreaterThan(-1);
  const end = source.indexOf('\n  });', start);
  expect(end, `handler block for ${channel} has no terminator`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('高权限 ghost IPC 的来源闸(源码契约)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');

  for (const channel of TRUSTED_SENDER_CHANNELS) {
    it(`${channel} 断言 assertTrustedAppRendererEvent 且不吞 sender`, () => {
      const block = handlerBlock(source, channel);
      expect(block, `${channel} 缺 assertTrustedAppRendererEvent`).toContain(
        'assertTrustedAppRendererEvent(event)',
      );
      // 断言按真实 event 判定,而不是把 sender 声明成 `_event` 后忽略。
      expect(
        /ipcMain\.handle\([^,]+,\s*(?:async\s*)?\(\s*_event\b/.test(block),
        `${channel} 用 _event 忽略了来源,无法校验 sender`,
      ).toBe(false);
    });
  }
});
