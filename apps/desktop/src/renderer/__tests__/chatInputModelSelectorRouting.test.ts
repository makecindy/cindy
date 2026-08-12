import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const chatInputSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'ChatInput.tsx'),
  'utf8',
);

describe('ChatInput model source switching wiring', () => {
  it('lets a disconnected source reselect the highlighted fallback provider row', () => {
    const selectorStart = chatInputSource.lastIndexOf('<ModelSelector');
    expect(selectorStart).toBeGreaterThanOrEqual(0);

    const selectorEnd = chatInputSource.indexOf('/>', selectorStart);
    expect(selectorEnd).toBeGreaterThan(selectorStart);

    const selectorBlock = chatInputSource.slice(selectorStart, selectorEnd + 2);

    expect(selectorBlock).toContain('sourceDisconnected={selectedSourceDisconnected}');
    expect(selectorBlock).toContain('reselectEmitsChange={selectedSourceDisconnected}');
  });

  /**
   * 统一模型选择器(model-selector-unified M5 / M6)在 composer 上的接线锁。
   * 这三条各自堵一个「模块写完了但没有调用点」的洞:面板开关、会话内跨引擎入口、
   * 新会话选中直通。任一条掉了,统一面板对用户就是不存在 / 或者存在但按钮点不动。
   */
  it('wires the unified model panel into both composer entries', () => {
    const selectorStart = chatInputSource.lastIndexOf('<ModelSelector');
    const selectorBlock = chatInputSource.slice(
      selectorStart,
      chatInputSource.indexOf('/>', selectorStart) + 2,
    );

    expect(selectorBlock).toContain('unifiedPanel={unifiedPanelActive}');
    // 会话内:同引擎过滤 + 跨引擎交给 performAgentSwitch。
    expect(selectorBlock).toContain('sessionEngineFilter={sessionEngineFilter}');
    // 新会话:选中直通(草稿),仅无 sessionId 时下发。
    expect(selectorBlock).toContain('!sessionId && unifiedPanelActive && onUnifiedDraftSelect');
    expect(selectorBlock).toContain('selectedFavoriteUid={selectedFavoriteUid}');
  });

  it('does not render the legacy two-step agent segments under the unified panel', () => {
    const selectorStart = chatInputSource.lastIndexOf('<ModelSelector');
    const selectorBlock = chatInputSource.slice(
      selectorStart,
      chatInputSource.indexOf('/>', selectorStart) + 2,
    );
    // agentSwitch 与 sessionEngineFilter 是**互斥**的两种会话内形态(见 ModelSelector 的
    // prop 说明)。同时传会得到一个永远不渲染的分段,等于埋一个看不见的死入口。
    expect(selectorBlock).toContain('!unifiedPanelActive &&');
  });

  it('locks the union list to the current engine when no cross-engine transaction exists', () => {
    // 会话内拿不到 sessionEngineFilter(SSH 远程 / 被控端不支持 session-agent-switch)时,
    // useUnifiedRowActions.selectRow 不会改道切换事务 —— 跨引擎行会被当普通选中交给
    // 单引擎链路,把另一个引擎的模型塞进当前会话。护栏:这类会话把联合列表锁定在
    // 当前引擎;引擎解析不出时整个回落旧面板。
    expect(chatInputSource).toContain(
      'const inSessionEngineLocked = Boolean(sessionId) && !sessionEngineFilter;',
    );
    expect(chatInputSource).toContain(
      'unifiedModelPanelEnabled && (!inSessionEngineLocked || agentKind !== null)',
    );
    expect(chatInputSource).toContain(
      'inSessionEngineLocked && agentKind ? [agentKind] : unifiedAgents',
    );
  });

  it('falls back to the legacy panel only when the controlled device has no provider catalog', () => {
    // device-link 老被控端 capabilities-only:联合列表的数据源是供应商目录,没有目录
    // 就是一张空列表。判据必须是结构化的 unsupported,不是 providers.length===0
    // (后者在加载中恒成立,会让面板每次打开先闪一下旧布局)。
    expect(chatInputSource).toContain(
      'const unifiedModelPanelEnabled = !deviceLinkDeviceId || !remoteProviders.unsupported;',
    );
  });

  it('keeps fastMode out of the cross-engine switch payload', () => {
    const start = chatInputSource.indexOf('const sessionEngineFilter = useMemo(');
    expect(start).toBeGreaterThan(-1);
    const block = chatInputSource.slice(start, chatInputSource.indexOf('}, [', start));
    // 确认弹窗照旧(同一份 confirmAgentBrowseSwitch,含「不再提示」偏好);
    expect(block).toContain('confirmAgentBrowseSwitch()');
    // 切换事务照旧;effort 显式带上(用户看着点下去的档),fastMode **不**带 ——
    // 由 performAgentSwitch 按目标引擎重新解析,旧引擎的 Fast 不跨引擎带入。
    expect(block).toContain('performAgentSwitchRef.current(');
    expect(block).toContain("effort ? { effort } : undefined");
    expect(block).not.toContain('fastMode');
  });
});
