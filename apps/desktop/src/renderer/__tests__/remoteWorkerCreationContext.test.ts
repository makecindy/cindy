import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (relativePath: string): string =>
  readFileSync(resolve(__dirname, '..', relativePath), 'utf8').replace(/\r\n/g, '\n');

describe('remote Orca Worker creation context', () => {
  it('scopes capabilities, providers, and the nested model selector to the controlled device', () => {
    const popover = read('features/cc-agent/CreateWorkerPopover.tsx');

    expect(popover).toContain("useAgentCapabilities('claude-code', deviceId)");
    expect(popover).toContain("useAgentCapabilities('codex', deviceId)");
    expect(popover).toContain('useDeviceProviders(deviceId)');
    expect(popover).toContain(
      'providersUnsupported: deviceId ? remoteProviders.unsupported : false',
    );
    expect(popover).toContain('!remoteModelListBlocked');
    expect(popover).toContain('deviceId={deviceId}');
  });

  it('blocks existing remote session sends while the model catalog is loading or failed', () => {
    const chatInput = read('components/new-chat/ChatInput.tsx');

    expect(chatInput).toContain('const remoteModelListStatus = resolveRemoteModelListStatus({');
    expect(chatInput).toContain("remoteModelListStatus !== 'ready'");
    expect(chatInput).toContain('if (remoteModelListBlocked) {');
    expect(chatInput).toContain('remoteModelListBlocked ||');

    const sendPreflightStart = chatInput.indexOf('// 预检(通用、provider-aware)');
    const sendPreflightEnd = chatInput.indexOf('// 评论截图并入发送附件', sendPreflightStart);
    expect(sendPreflightStart).toBeGreaterThan(-1);
    expect(sendPreflightEnd).toBeGreaterThan(sendPreflightStart);
    expect(chatInput.slice(sendPreflightStart, sendPreflightEnd)).toContain(
      '!(deviceLinkDeviceId && remoteProviders.unsupported)',
    );
  });

  it('passes the same device context through both Worker creation entry points', () => {
    const sessionView = read('features/cc-agent/CCAgentSessionView.tsx');
    const workerPanel = read('features/cc-agent/OrcaWorkerPanel.tsx');
    const workersPlugin = read('features/right-sidebar/plugins/orca-workers/index.tsx');

    expect(sessionView).toContain('deviceId={remoteDeviceId}');
    expect(workerPanel).toContain('deviceId={deviceId}');
    expect(workersPlugin).toContain('deviceId={leadSession?.deviceLinkDeviceId}');
  });

  it('never uses the controller API key to gate a remote model row', () => {
    const selector = read('components/new-chat/ModelSelector.tsx');

    // 本地会话仍只按 codex/ + hasSavedKey 准入;SSH 远程额外按订阅直连前缀禁用
    // (不可路由)。device-link 远程在目录未就绪或真实读取失败时禁用旧行，
    // 只有明确判定老被控端不支持 provider:list 时才回退 capabilities flat list；
    // 任一远程路径都不得回退到 controller key 判定。
    expect(selector).toContain('if (!deviceId) {');
    expect(selector).toContain('if (subscriptionDirectDisabledReason(id)) return true;');
    expect(selector).toContain("return id.startsWith('codex/') && !hasSavedKey;");
    expect(selector).toContain("if (remoteModelListStatus !== 'ready') return true;");
    expect(selector).toContain(
      'if (remoteProviders.error) return remoteProviders.unsupported ? false : true;',
    );
    expect(selector).toContain('const rowAgentKind = resolveVisibleModelAgentKind({');
    expect(selector).toContain('providerOffersModel(provider, id, rowAgentKind)');
  });
});
