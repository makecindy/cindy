import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { GhostPanelAgentBridge, type GhostPanelAgentBridgeDeps } from '../panelAgentBridge';
import { resolveGhostPanelTargetSessionId } from '../panelAgentTarget';
import {
  ghostPanelContextForWebContents,
  registerGhostPanelWebContents,
  unregisterGhostPanelWebContents,
} from '../runtime/ghostPanelWebContents';

function makeBridge(overrides: Partial<GhostPanelAgentBridgeDeps> = {}) {
  const deps: GhostPanelAgentBridgeDeps = {
    panelContext: (senderId) =>
      senderId === 11 ? { ghostId: 'alpha', hostWebContentsId: 22 } : null,
    hasAgentPermission: (ghostId) => ghostId === 'alpha',
    targetSessionId: (hostId) => (hostId === 22 ? 'session-current' : null),
    isInteractive: () => true,
    confirmSend: vi.fn(async () => ({ ok: true as const, confirmed: true })),
    issueUserActionToken: vi.fn(() => 'panel-token'),
    run: vi.fn(async () => ({
      ok: true as const,
      sessionId: 'session-current',
      mode: 'continue' as const,
      disposition: 'active' as const,
    })),
    ...overrides,
  };
  return { bridge: new GhostPanelAgentBridge(deps), deps };
}

describe('GhostPanelAgentBridge', () => {
  it('只返回是否存在当前目标，不向面板泄露 sessionId', () => {
    const { bridge } = makeBridge();
    expect(bridge.getTarget(11)).toEqual({ ok: true, available: true });
    expect(bridge.getTarget(99)).toMatchObject({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
    });
  });

  it('固定 continue + user-action，并用 Host 解析的任务签发票据', async () => {
    const { bridge, deps } = makeBridge();
    const result = await bridge.send(11, {
      message: '继续处理所选资源',
      context: { nodeId: 'node-1' },
    });

    expect(deps.issueUserActionToken).toHaveBeenCalledWith('alpha', 'session-current');
    expect(deps.confirmSend).toHaveBeenCalledWith('alpha', '继续处理所选资源');
    expect(deps.run).toHaveBeenCalledWith('alpha', {
      type: 'agent-request',
      mode: 'continue',
      trigger: 'user-action',
      promptTemplate:
        '{{user_message}}\n\n<plugin_panel_context>\n{{event_json}}\n</plugin_panel_context>',
      userMessage: '继续处理所选资源',
      event: { nodeId: 'node-1' },
      userActionToken: 'panel-token',
    });
    expect(result).toEqual({ ok: true, disposition: 'active' });
    expect(result).not.toHaveProperty('sessionId');
  });

  it('没有 context 时只发送用户原文，不生成空上下文标签', async () => {
    const { bridge, deps } = makeBridge();

    await bridge.send(11, { message: '你好' });

    expect(deps.run).toHaveBeenCalledWith('alpha', {
      type: 'agent-request',
      mode: 'continue',
      trigger: 'user-action',
      promptTemplate: '{{user_message}}',
      userMessage: '你好',
      event: null,
      userActionToken: 'panel-token',
    });
  });

  it('用户取消宿主确认时不签票也不启动 Agent', async () => {
    const { bridge, deps } = makeBridge({
      confirmSend: vi.fn(async () => ({ ok: true as const, confirmed: false })),
    });

    expect(await bridge.send(11, { message: '不要直接发送' })).toMatchObject({
      ok: false,
      errorCode: 'USER_ACTION_REQUIRED',
    });
    expect(deps.issueUserActionToken).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
  });

  it('确认期间切换任务时 fail closed', async () => {
    const targetSessionId = vi
      .fn<(hostId: number) => string | null>()
      .mockReturnValueOnce('session-current')
      .mockReturnValueOnce('session-other');
    const { bridge, deps } = makeBridge({ targetSessionId });

    expect(await bridge.send(11, { message: '继续' })).toMatchObject({
      ok: false,
      errorCode: 'NO_ACTIVE_SESSION',
    });
    expect(deps.issueUserActionToken).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
  });

  it('拒绝 JSON 无法无损表达的 context，且不弹确认框', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const sparse = new Array(2);
    sparse[0] = 'x';
    const invalidContexts = [
      new Map([['node', 1]]),
      new Set(['node']),
      new Date(),
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -0,
      { missing: undefined },
      sparse,
      circular,
    ];

    for (const context of invalidContexts) {
      const { bridge, deps } = makeBridge();
      expect(await bridge.send(11, { message: '继续', context })).toMatchObject({
        ok: false,
        errorCode: 'INVALID_REQUEST',
      });
      expect(deps.confirmSend).not.toHaveBeenCalled();
      expect(deps.issueUserActionToken).not.toHaveBeenCalled();
      expect(deps.run).not.toHaveBeenCalled();
    }
  });

  it('拒绝 sessionId、mode 等越界字段，不签票也不运行', async () => {
    const { bridge, deps } = makeBridge();
    const result = await bridge.send(11, {
      message: '尝试越权',
      sessionId: 'session-other',
      mode: 'fork',
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'INVALID_REQUEST' });
    expect(deps.issueUserActionToken).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
  });

  it('没有当前任务或面板不可交互时 fail closed', async () => {
    const noSession = makeBridge({ targetSessionId: () => null });
    const hidden = makeBridge({ isInteractive: () => false });

    expect(await noSession.bridge.send(11, { message: '继续' })).toMatchObject({
      ok: false,
      errorCode: 'NO_ACTIVE_SESSION',
    });
    expect(await hidden.bridge.send(11, { message: '继续' })).toMatchObject({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
    });
    expect(noSession.deps.run).not.toHaveBeenCalled();
    expect(hidden.deps.run).not.toHaveBeenCalled();
  });

  it('拒绝空消息和不可识别的 sender', async () => {
    const { bridge } = makeBridge();
    expect(await bridge.send(11, { message: '   ' })).toMatchObject({
      ok: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(await bridge.send(404, { message: '继续' })).toMatchObject({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
    });
  });
});

describe('resolveGhostPanelTargetSessionId', () => {
  it('停靠面板只取承载主窗口自己的当前任务', () => {
    expect(
      resolveGhostPanelTargetSessionId({
        hostIsMainShell: true,
        hostSessionId: ' session-host ',
        mainShellSessionIds: ['session-other'],
      }),
    ).toBe('session-host');
  });

  it('独立面板窗仅在主窗口唯一时回落', () => {
    expect(
      resolveGhostPanelTargetSessionId({
        hostIsMainShell: false,
        hostSessionId: null,
        mainShellSessionIds: ['session-only'],
      }),
    ).toBe('session-only');
  });

  it('多主窗口歧义或唯一窗口不在任务页时 fail closed', () => {
    expect(
      resolveGhostPanelTargetSessionId({
        hostIsMainShell: false,
        hostSessionId: null,
        mainShellSessionIds: ['session-a', 'session-b'],
      }),
    ).toBeNull();
    expect(
      resolveGhostPanelTargetSessionId({
        hostIsMainShell: false,
        hostSessionId: null,
        mainShellSessionIds: [null],
      }),
    ).toBeNull();
  });
});

describe('ghostPanelWebContents registry', () => {
  it('由 Host 登记 guest → ghost/host 绑定，并在销毁时清理', () => {
    registerGhostPanelWebContents(101, { ghostId: 'alpha', hostWebContentsId: 202 });
    expect(ghostPanelContextForWebContents(101)).toEqual({
      ghostId: 'alpha',
      hostWebContentsId: 202,
    });

    unregisterGhostPanelWebContents(101);
    expect(ghostPanelContextForWebContents(101)).toBeNull();
  });

  it('查询返回副本，调用方不能篡改注册身份', () => {
    registerGhostPanelWebContents(102, { ghostId: 'alpha', hostWebContentsId: 203 });
    const context = ghostPanelContextForWebContents(102)!;
    context.ghostId = 'forged';

    expect(ghostPanelContextForWebContents(102)?.ghostId).toBe('alpha');
    unregisterGhostPanelWebContents(102);
  });
});

const desktopRoot = process.cwd().endsWith(`${path.sep}apps${path.sep}desktop`)
  ? process.cwd()
  : path.join(process.cwd(), 'apps', 'desktop');
const preloadSource = readFileSync(
  path.join(desktopRoot, 'src', 'preload', 'ghostPanelGuestPreload.ts'),
  'utf8',
);

describe('ghostPanelGuestPreload contract', () => {
  it('只暴露固定的 agent.getTarget/send，不暴露通用 IPC 或电子脑管子', () => {
    expect(preloadSource).toContain("contextBridge.exposeInMainWorld('cindyPanel'");
    expect(preloadSource).not.toContain("exposeInMainWorld('cindy'");
    expect(preloadSource).toContain('getTarget:');
    expect(preloadSource).toContain('send:');
    expect(preloadSource).not.toContain("exposeInMainWorld('electronAPI'");
    expect(preloadSource).not.toContain('onHostMessage');
    expect(preloadSource).not.toContain('ipcRenderer.send(');
  });

  it('真实用户激活短时、单次消费后才调用发送 IPC', () => {
    expect(preloadSource).toContain('event.isTrusted');
    expect(preloadSource).toContain('navigator.userActivation?.isActive === true');
    expect(preloadSource).toContain('activationExpiresAt = 0');
    expect(preloadSource).toContain("errorCode: 'USER_ACTION_REQUIRED'");
    expect(preloadSource).toContain('GHOST_PANEL_AGENT_SEND_CHANNEL, request');
  });
});
