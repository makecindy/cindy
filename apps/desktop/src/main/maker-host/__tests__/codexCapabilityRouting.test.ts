/*
 * 测试价值
 * - 生产入口与可观察结果：createCodexCapabilityRouting 交给 Codex 的 capabilityRouting 与
 *   resolveCapabilityRouting 结果。桌面 Codex 构造点与 Node Host 都用它。
 * - 规则依据：函数体从 maker-host/index.ts 原样搬来——电脑操作是否可用读「已应用」的 MCP 桥服务名；
 *   插件禁用先看本次 vendorOptions，没有才读工作区偏好；Cindy 浏览器被禁用且本机已开通 Codex
 *   浏览器时才去确认它就绪。两项都在调用时读，不在创建时读死。
 * - 最小失败输入：创建时读死桥名；vendorOptions 有值仍读工作区偏好；远程任务也去确认本机浏览器。
 * - tier：unit（纯函数，端口为假实现）。
 */
import { describe, expect, it, vi } from 'vitest';

import { buildDesktopCapabilityRoutingPolicy } from '../capability-routing.js';
import { CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY } from '../../mcp-integrations/codexBuiltinToolPolicy.js';
import { createCodexCapabilityRouting } from '../codexCapabilityRouting.js';

describe('createCodexCapabilityRouting', () => {
  it('reads the applied bridge on every call', () => {
    let names: string[] | null = null;
    const routing = createCodexCapabilityRouting({ getBridgeServerNames: () => names, getDisabledRuntimePluginIds: () => [] });
    expect(routing.capabilityRouting()).toEqual(buildDesktopCapabilityRoutingPolicy({ cindyComputerAvailable: false }));
    names = ['cindy_computer'];
    expect(routing.capabilityRouting()).toEqual(buildDesktopCapabilityRoutingPolicy({ cindyComputerAvailable: true }));
  });

  it('prefers the task vendorOptions over workdir preferences and checks the local Codex browser only when needed', async () => {
    const getDisabledRuntimePluginIds = vi.fn(() => ['browser']);
    const routing = createCodexCapabilityRouting({ getBridgeServerNames: () => null, getDisabledRuntimePluginIds });
    const ensureCodexBrowserUseReady = vi.fn(async () => true);
    const fromOptions = await routing.resolveCapabilityRouting({
      workingDir: '/work', vendorOptions: { [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: [] },
      codexBrowserUseProvisioned: true, ensureCodexBrowserUseReady,
    } as never);
    expect(getDisabledRuntimePluginIds).not.toHaveBeenCalled();
    expect(ensureCodexBrowserUseReady).not.toHaveBeenCalled();
    expect(fromOptions).toEqual(buildDesktopCapabilityRoutingPolicy({
      cindyComputerAvailable: false, cindyBrowserEnabled: true, codexBrowserUseAvailable: true, codexBrowserUseProvisioned: true,
    }));

    const fromPrefs = await routing.resolveCapabilityRouting({
      workingDir: '/work', codexBrowserUseProvisioned: true, ensureCodexBrowserUseReady,
    } as never);
    expect(getDisabledRuntimePluginIds).toHaveBeenCalledWith('/work');
    expect(ensureCodexBrowserUseReady).toHaveBeenCalledTimes(1);
    expect(fromPrefs).toEqual(buildDesktopCapabilityRoutingPolicy({
      cindyComputerAvailable: false, cindyBrowserEnabled: false, codexBrowserUseAvailable: true, codexBrowserUseProvisioned: true,
    }));

    await routing.resolveCapabilityRouting({
      workingDir: '/work', remoteHostId: 'ssh-1', codexBrowserUseProvisioned: true, ensureCodexBrowserUseReady,
    } as never);
    expect(ensureCodexBrowserUseReady).toHaveBeenCalledTimes(1);
  });
});
