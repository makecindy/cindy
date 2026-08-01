/**
 * session-agent-switch 的 device-link 远程会话接线回归。
 *
 * 背景:同会话跨引擎切换(Claude Code ↔ Codex)的 channel 早已在 device-link allowlist 里
 * (手机版控制端在用),但桌面控制端一度把入口按 v1 限制关掉、切换 IPC 也硬打本机 maker —— 远程
 * 会话在被控端才有,打本机必失败。这里锁住三件事:
 *   1. 传输层按 session 来源路由(远程隧道 / 本机直连,args 与 preload 对齐);
 *   2. 意图镜像的归一化与幂等(权威态在会话所在端,控制端只做镜像);
 *   3. ChatInput 的入口门控不再排除 device-link,且切换走传输层。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';

const sess = (id: string): Session => ({ id }) as unknown as Session;

describe('makerApiFor 的 agent 切换路由', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function stubElectron() {
    const maker = {
      switchSessionAgent: vi.fn().mockResolvedValue({ deferred: true }),
      getSessionAgentSwitchIntent: vi.fn().mockResolvedValue(null),
    };
    const invoke = vi.fn().mockResolvedValue(null);
    vi.stubGlobal('window', { electronAPI: { maker, deviceLink: { invoke } } });
    return { maker, invoke };
  }

  it('远程会话:登记 / 读回都命中被控端 channel(入参顺序与 preload 一致)', async () => {
    const { maker, invoke } = stubElectron();
    const { makerApiFor } = await import('@/lib/makerTransport');
    const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');
    remoteProjectsStore.setDeviceSessions('dev-1', 'Mac', [sess('remote-1')]);

    const api = makerApiFor('remote-1');
    await api.switchSessionAgent('remote-1', 'codex', 'gpt-5.5', 'openai', 'high', true);
    await api.getSessionAgentSwitchIntent('remote-1');

    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:switch-session-agent', [
      'remote-1',
      'codex',
      'gpt-5.5',
      'openai',
      'high',
      true,
    ]);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:get-session-agent-switch-intent', [
      'remote-1',
    ]);
    // 远程会话在控制端本机不存在,绝不能打本机 maker。
    expect(maker.switchSessionAgent).not.toHaveBeenCalled();
    expect(maker.getSessionAgentSwitchIntent).not.toHaveBeenCalled();
  });

  it('本机会话:直连本机 maker,不经隧道(零回归)', async () => {
    const { maker, invoke } = stubElectron();
    const { makerApiFor } = await import('@/lib/makerTransport');

    const api = makerApiFor('local-1'); // 未注册进 remoteProjectsStore → 本机
    await api.switchSessionAgent('local-1', 'codex', 'gpt-5.5', 'openai', 'high', false);
    await api.getSessionAgentSwitchIntent('local-1');

    expect(maker.switchSessionAgent).toHaveBeenCalledWith(
      'local-1',
      'codex',
      'gpt-5.5',
      'openai',
      'high',
      false,
    );
    expect(maker.getSessionAgentSwitchIntent).toHaveBeenCalledWith('local-1');
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('makerChatStore.mirrorAgentSwitchIntent', () => {
  // 模块级 sessions Map 跨用例持久 → 每个用例用唯一 sessionId 隔离。
  let n = 0;
  const sid = () => `agent-switch-mirror-${n++}`;

  it('wire 投影(targetAgentKind)收窄成展示记录(target),providerId 缺失按 null', async () => {
    const { makerChatStore } = await import('@/lib/makerChatStore');
    const s = sid();
    makerChatStore.mirrorAgentSwitchIntent(s, {
      targetAgentKind: 'codex',
      model: 'gpt-5.5',
      effort: 'high',
      fastMode: true,
    });
    expect(makerChatStore.getSnapshot(s).agentSwitchIntent).toEqual({
      target: 'codex',
      model: 'gpt-5.5',
      providerId: null,
      effort: 'high',
      fastMode: true,
    });
    // 展示槽独立:真实 reducer 路由不受影响。
    expect(makerChatStore.getSnapshot(s).agentKind).toBe('claude-code');
  });

  it('幂等:同值回声不重建快照(不与本端乐观登记打架)', async () => {
    const { makerChatStore } = await import('@/lib/makerChatStore');
    const s = sid();
    makerChatStore.noteAgentSwitchIntent(s, 'codex', { model: 'gpt-5.5', providerId: 'openai' });
    const snap = makerChatStore.getSnapshot(s);
    makerChatStore.mirrorAgentSwitchIntent(s, {
      targetAgentKind: 'codex',
      model: 'gpt-5.5',
      providerId: 'openai',
    });
    expect(makerChatStore.getSnapshot(s)).toBe(snap); // 引用不变 = 未触发更新
  });

  it('null / 非法值 = 无意图 → 清除', async () => {
    const { makerChatStore } = await import('@/lib/makerChatStore');
    const s = sid();
    makerChatStore.noteAgentSwitchIntent(s, 'codex', { model: 'gpt-5.5', providerId: null });
    makerChatStore.mirrorAgentSwitchIntent(s, null);
    expect(makerChatStore.getSnapshot(s).agentSwitchIntent).toBeNull();

    makerChatStore.noteAgentSwitchIntent(s, 'codex', { model: 'gpt-5.5', providerId: null });
    makerChatStore.mirrorAgentSwitchIntent(s, { targetAgentKind: 'gemini', model: 'x' });
    expect(makerChatStore.getSnapshot(s).agentSwitchIntent).toBeNull();
  });

  it('sessions:patched 带 agentSwitchIntent 才镜像;不带该字段的普通 patch 不得清掉意图', async () => {
    const { makerChatStore } = await import('@/lib/makerChatStore');
    const s = sid();
    // 被控端 / 另一窗口登记 → 回流镜像进控制端展示槽。
    makerChatStore.mirrorSessionFields(s, {
      agentSwitchIntent: { targetAgentKind: 'codex', model: 'gpt-5.5', providerId: 'openai' },
    });
    expect(makerChatStore.getSnapshot(s).agentSwitchIntent?.target).toBe('codex');

    // 标题 / preview 之类的无关广播不带该字段:意图必须原样保留。
    makerChatStore.mirrorSessionFields(s, { title: 'x' } as { fastMode?: unknown });
    expect(makerChatStore.getSnapshot(s).agentSwitchIntent?.target).toBe('codex');

    // 被控端清除意图(apply 完成 / 用户撤销)→ 显式 null 才清。
    makerChatStore.mirrorSessionFields(s, { agentSwitchIntent: null });
    expect(makerChatStore.getSnapshot(s).agentSwitchIntent).toBeNull();
  });
});

describe('ChatInput 的入口门控与调用路由', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/renderer/components/new-chat/ChatInput.tsx'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('切换 IPC 走传输层(远程会话隧道到被控端),不再硬打本机 maker', () => {
    expect(source).toContain('await makerApiFor(sessionId).switchSessionAgent(');
    expect(source).not.toContain('window.electronAPI.maker.switchSessionAgent(');
  });

  it('入口按被控端能力位门控:device-link 不再被排除,SSH 远程仍排除', () => {
    expect(source).toContain(
      'sessionId && vendorKey && !remoteHostId && sessionAgentSwitchSupported',
    );
    expect(source).toContain('ccCaps.capabilities?.supportsSessionAgentSwitch === true');
    expect(source).toContain('codexCaps.capabilities?.supportsSessionAgentSwitch === true');
  });

  it('远程会话打开时读回被控端权威意图', () => {
    expect(source).toContain('.getSessionAgentSwitchIntent(sessionId)');
    expect(source).toContain('makerChatStore.mirrorAgentSwitchIntent(sessionId, remoteIntent)');
  });
});
