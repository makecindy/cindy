import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StartSessionOptions } from '@cindy/maker-core';

import { hasRunningPluginEngineTurn, resetPluginEngineSessionsForTests } from '../../cindy-brain/pluginHarnesses.js';
import { buildAcpAgentCore } from '../acpHostCore.js';

// 测试价值
// - 生产入口与可观察结果：buildAcpAgentCore（installPluginEngines 注册的 ACP 引擎）开出的任务会话，
//   在消息准备发送或回合运行期间让 hasRunningPluginEngineTurn(插件实例) 为 true，会话 close 后
//   不再登记。插件市场的后台自动更新以此判断是否延后。
// - Bug 依据：2026-11-28 后台自动更新停掉 Antigravity 插件，正在跑回合的 4 个任务被直接打断；
//   #13717 的 P1 审查指出最终检查前还可能有新消息正在准备发送。
// - 现有覆盖缺口：acpHostCore 此前没有测试；service.test 只验证市场按登记结果延后，不验证真实
//   引擎会话会被登记、关闭后会注销。
// - 最小失败输入：一个 acp-plugin 供应商会话的 send 尚未完成、isTurnRunning 仍为 false。
// - tier：unit（AcpAgent 用内存 fake 代替，不起真实进程）。独立成文件：acpHostCore 没有现成测试文件，
//   需要在模块级替换 AcpAgent。

const fakeSessions = vi.hoisted((): Array<{ isTurnRunning: () => boolean; close: () => Promise<void>; send: () => Promise<void>; running: boolean }> => []);
const startGate = vi.hoisted((): { wait: Promise<void> | null } => ({ wait: null }));

vi.mock('@cindy/maker-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cindy/maker-core')>();
  class FakeAcpAgent {
    async startSession(_options: StartSessionOptions) {
      if (startGate.wait) await startGate.wait;
      const session = {
        running: true,
        isTurnRunning() { return session.running; },
        async send() {},
        async close() { session.running = false; },
      };
      fakeSessions.push(session);
      return session;
    }
  }
  return { ...actual, AcpAgent: FakeAcpAgent };
});

afterEach(() => {
  fakeSessions.length = 0;
  startGate.wait = null;
  resetPluginEngineSessionsForTests();
});

describe('plugin engine turn tracking', () => {
  it('reports a running turn for the plugin instance until the task session closes', async () => {
    const agent = buildAcpAgentCore({
      logger: { child: () => ({}) } as never,
      appVersion: '0.0.0',
      preparePiExtraSpawnConfig: vi.fn() as never,
      spawnHarness: vi.fn() as never,
    });

    const handle = await agent.startSession({ providerId: 'acp-plugin:_root__engine-plugin:agy' } as StartSessionOptions);
    expect(hasRunningPluginEngineTurn('_root__engine-plugin')).toBe(true);
    expect(hasRunningPluginEngineTurn('other-plugin')).toBe(false);

    // An idle session keeps its engine process for a while; that alone must not hold updates back.
    fakeSessions[0].running = false;
    expect(hasRunningPluginEngineTurn('_root__engine-plugin')).toBe(false);

    fakeSessions[0].running = true;
    await handle.close();
    fakeSessions[0].running = true;
    expect(hasRunningPluginEngineTurn('_root__engine-plugin')).toBe(false);
  });

  it('counts a message being prepared before the ACP turn begins', async () => {
    const agent = buildAcpAgentCore({
      logger: { child: () => ({}) } as never,
      appVersion: '0.0.0',
      preparePiExtraSpawnConfig: vi.fn() as never,
      spawnHarness: vi.fn() as never,
    });
    const handle = await agent.startSession({ providerId: 'acp-plugin:_root__engine-plugin:agy' } as StartSessionOptions);
    fakeSessions[0].running = false;
    let accept!: () => void;
    fakeSessions[0].send = () => new Promise<void>((resolve) => { accept = resolve; });

    const sending = handle.send({ type: 'user', content: 'continue' });
    expect(hasRunningPluginEngineTurn('_root__engine-plugin')).toBe(true);
    accept();
    await sending;
    expect(hasRunningPluginEngineTurn('_root__engine-plugin')).toBe(false);
    await handle.close();
  });

  it('counts a session that is still opening', async () => {
    const agent = buildAcpAgentCore({
      logger: { child: () => ({}) } as never,
      appVersion: '0.0.0',
      preparePiExtraSpawnConfig: vi.fn() as never,
      spawnHarness: vi.fn() as never,
    });
    let finishOpening!: () => void;
    startGate.wait = new Promise<void>((resolve) => { finishOpening = resolve; });
    const starting = agent.startSession({ providerId: 'acp-plugin:_root__engine-plugin:agy' } as StartSessionOptions);
    expect(hasRunningPluginEngineTurn('_root__engine-plugin')).toBe(true);
    finishOpening();
    const handle = await starting;
    fakeSessions[0].running = false;
    expect(hasRunningPluginEngineTurn('_root__engine-plugin')).toBe(false);
    await handle.close();
  });
});
