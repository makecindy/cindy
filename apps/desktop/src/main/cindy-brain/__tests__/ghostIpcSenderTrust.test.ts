import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { isValidGhostId } from '../../../shared/ghost.js';
import { isPluginInstanceKey } from '../../../shared/pluginIdentity.js';
import { createGhostProductionCallbacks } from './ghostProductionCallbacksFixture.js';

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
  'ghosts:install-github-release',
  'ghosts:update',
  'ghosts:inspect',
  'ghosts:uninstall',
  'ghosts:export',
  'ghosts:set-enabled',
  'ghosts:restore-builtin',
  'ghosts:mark-used',
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

  it('keeps task permission retry behind the trusted Host sender gate', () => {
    const block = handlerBlock(source, 'ghosts:request-task-approval');
    expect(block.indexOf('assertTrustedAppRendererEvent(event)')).toBeLessThan(block.indexOf('requestPluginTaskApproval'));
    expect(block).toContain('requireGhostAvailableForActiveSession(id)');
    expect(block).toContain("purpose: 'task-capability'");
  });

  it('uses the specific capability requested by the settings IPC, with tasks only as the legacy default', async () => {
    const load = createGhostProductionCallbacks<{
      requestApproval(event: unknown, id: string, capability?: unknown): Promise<{ granted: boolean }>;
    }>({ callbacks: { requestApproval: ['ipcMain.handle', 'ghosts:request-task-approval'] } });
    const sender = { isDestroyed: () => false };
    const event = { sender };
    const confirm = vi.fn(async () => true);
    const requestPluginTaskApproval = vi.fn(async (
      _id: string, isCurrent: () => boolean, prompt: (facts: unknown) => Promise<boolean>,
      _explicit: boolean, capability: string,
    ) => isCurrent() && await prompt({ capability }));
    const { requestApproval } = load({
      assertTrustedAppRendererEvent: (candidate: unknown) => {
        if (candidate !== event) throw new Error('UNTRUSTED');
      },
      requireGhostAvailableForActiveSession: vi.fn(),
      throwIpcError: (code: string) => { throw new Error(code); },
      requestPluginTaskApproval,
      createWindowGhostInstallConsentPrompt: () => confirm,
      broadcastGhostsChanged: vi.fn(),
      getGhostManager: () => ({ list: () => [] }),
    });
    for (const [input, expected] of [
      ['checks', 'checks'], ['observe', 'observe'], ['companions', 'companions'], [undefined, 'tasks'],
    ] as const) {
      await expect(requestApproval(event, 'example', input)).resolves.toEqual({ granted: true });
      expect(requestPluginTaskApproval).toHaveBeenLastCalledWith('example', expect.any(Function), expect.any(Function), true, expected);
      expect(confirm).toHaveBeenLastCalledWith(expect.objectContaining({ purpose: 'task-capability', facts: { capability: expected } }));
    }
    await expect(requestApproval(event, 'example', 'delegation')).rejects.toThrow('INVALID_PARAMS');
    await expect(requestApproval({ sender }, 'example', 'checks')).rejects.toThrow('UNTRUSTED');
    expect(requestPluginTaskApproval).toHaveBeenCalledTimes(4);
  });

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

  it('keeps recommendation snapshots behind the trusted app frame check', () => {
    const start = source.indexOf("ipcMain.on('ghosts:recommendations'");
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf('\n  });', start));
    expect(block).toMatch(/if \(!isTrustedAppRendererEvent\(event\)\)\s*\{\s*event.returnValue = empty;\s*return;/);
    expect(block.indexOf('isTrustedAppRendererEvent')).toBeLessThan(
      block.indexOf('readGhostRecommendationEntries'),
    );
  });

  it('binds runtime replacement to the live logic sender, never a payload plugin id', () => {
    const block = handlerBlock(source, 'ghost-pipe:send');
    const updateStart = block.indexOf("if (type === 'recommendations-update')");
    expect(updateStart).toBeGreaterThan(-1);
    const beforeUpdate = block.slice(0, updateStart);
    expect(beforeUpdate).toContain('ghostIdForLogicWebContents(event.sender.id)');
    expect(beforeUpdate).toContain('requireGhostAvailableForActiveSession(id)');
    const update = block.slice(updateStart, block.indexOf("if (type === 'tool-result')"));
    expect(update).toContain('!ghost.enabled');
    expect(update).toContain('replaceGhostRecommendations(id,');
    expect(update).not.toMatch(/payload\.(?:id|ghostId)/);
  });
  it('accepts an organization instance key when acknowledging a retirement', () => {
    const block = handlerBlock(source, 'ghosts:acknowledge-retirement');
    expect(block).toContain('isPluginInstanceKey(id)');
    expect(block).not.toContain('isValidGhostId(id)');
    expect(isPluginInstanceKey('_ns__acme__x')).toBe(true);
    expect(isValidGhostId('_ns__acme__x')).toBe(false);
  });

});
