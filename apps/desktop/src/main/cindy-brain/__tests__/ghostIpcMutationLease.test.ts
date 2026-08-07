import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 源码契约测试:所有会改写插件世界(内容根/状态根/运行时)的 IPC 写路径,
 * handler 体内必须持 GhostMutationCoordinator 租约。
 *
 * 背景:GhostManager 与 ReceiptStore 的根路径都是调用时现解析的
 * (ownerScopedUserDataPath),账号切换边界只等待 coordinator
 * (bootstrap-electron 的 waitForGhostMutations)。写路径不持租约,异步窗口
 * (inspect/parse/hash)里切号落定,后半段写入就会漏进新 owner 的命名空间 ——
 * A 发起的安装落进 B、A 的内容目录配上 B 的 receipt。第 7 轮 review 实锤了
 * 本地 install/update/set-enabled 三条正是这么漏的(市场路径一直有租约)。
 *
 * index.ts 拉起整张 main 进程单例图,handler 无法脱离 electron 直测,所以用
 * 源码扫描钉契约:每个列出的 handler 块里必须出现 beginGhostMutation(取租约)
 * 与 captureGhostMutationOwner(入口同步捕获 owner,防"用切换后的 owner 取租约
 * 照样通过"——租约要核对的是发起时刻的 owner)。新增写路径 handler 时把名字加进
 * 清单;想移除租约必须先改掉 owner 动态解析这个前提。
 */

const MUTATING_GHOST_CHANNELS = [
  'ghosts:install',
  'ghosts:update',
  'ghosts:set-enabled',
] as const;

function handlerBlock(source: string, channel: string): string {
  const start = source.indexOf(`ipcMain.handle('${channel}'`);
  expect(start, `handler for ${channel} not found`).toBeGreaterThan(-1);
  // handler 以两空格缩进的 `});` 收尾(仓库排版惯例);取到那里足够覆盖整个闭包。
  const end = source.indexOf('\n  });', start);
  expect(end, `handler block for ${channel} has no terminator`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('ghost 写路径 IPC 的 owner 租约(源码契约)', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'index.ts'),
    'utf8',
  );

  for (const channel of MUTATING_GHOST_CHANNELS) {
    it(`${channel} 持租约且入口同步捕获 owner`, () => {
      const block = handlerBlock(source, channel);
      expect(block, `${channel} 缺 beginGhostMutation`).toContain('beginGhostMutation(');
      expect(block, `${channel} 缺 captureGhostMutationOwner`).toContain(
        'captureGhostMutationOwner()',
      );
    });
  }

  it('ghosts:reapprove-installed 持租约,owner 以 inspect 时点的一次性票据为准(更强于 handler 内 capture)', () => {
    // 第 8 轮 P0-2:owner 在 confirm 入口才 capture 绑不住"读事实那一刻"——确认卡
    // 停留期间切号,A 看的确认可以给 B 的同 id 目录铸批准。现在 inspect 发一次性
    // 票据(钉 owner + id + manifestSha256),confirm 原子消费并以**票据里的 owner**
    // 起租约:generation 不等直接拒。handler 内不该再出现 captureGhostMutationOwner
    // (那会退化回"用确认时刻的 owner",正是要消掉的形态)。
    const block = handlerBlock(source, 'ghosts:reapprove-installed');
    expect(block).toContain('reapproveTickets.consume(');
    expect(block).toContain('beginGhostMutation(ticket.owner)');
    expect(block).not.toContain('captureGhostMutationOwner()');
    // inspect 侧必须在读事实之前捕获 owner 并发票。
    const inspectBlock = handlerBlock(source, 'ghosts:reapprove-inspect');
    expect(inspectBlock).toContain('captureGhostMutationOwner()');
    expect(inspectBlock).toContain('reapproveTickets.issue(');
  });

  it('ghosts:uninstall 经 uninstallGhostAndCleanup 持租约(入口同步取,无异步窗口故无需 capture)', () => {
    const block = handlerBlock(source, 'ghosts:uninstall');
    expect(block).toContain('uninstallGhostAndCleanup(');
    // main 的 per-ghost 屏障重构后,外层委托 withGhostInstallLock,实际清理与租约在
    // ...Locked 内(lock 内取租约,包住整段清理)。契约钉在真正干活的 Locked 函数上。
    const outerStart = source.indexOf('export async function uninstallGhostAndCleanup');
    expect(outerStart).toBeGreaterThan(-1);
    const outer = source.slice(outerStart, source.indexOf('\n}', outerStart));
    expect(outer).toContain('withGhostInstallLock(');
    const start = source.indexOf('async function uninstallGhostAndCleanupLocked');
    expect(start).toBeGreaterThan(-1);
    const fn = source.slice(start, source.indexOf('\n}', start));
    expect(fn).toContain('beginGhostMutation(');
  });

  it('市场装入/更新持租约(installOrUpdateMarketGhostPackage)', () => {
    // 同上:外层委托 withGhostInstallLock,owner 捕获 + 起租约在 ...Locked 内。
    const outerStart = source.indexOf('export async function installOrUpdateMarketGhostPackage');
    expect(outerStart).toBeGreaterThan(-1);
    const outer = source.slice(outerStart, source.indexOf('\n}', outerStart));
    expect(outer).toContain('withGhostInstallLock(');
    const start = source.indexOf('async function installOrUpdateMarketGhostPackageLocked');
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf('\n}', start));
    expect(block).toContain('captureGhostMutationOwner()');
    expect(block).toContain('beginGhostMutation(');
  });
});
