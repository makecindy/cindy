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
    // 收藏锚点:草稿取调用方持有的那一份,会话取本组件的内存态(2026-08-17 review 第三轮 G4)。
    expect(selectorBlock).toContain('selectedFavoriteUid={effectiveSelectedFavoriteUid}');
    expect(selectorBlock).toContain('onSessionFavoriteAnchorChange={');
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
      'unifiedModelPanelEnabled && (!inSessionEngineLocked || lockedSessionAgentKind !== null)',
    );
    expect(chatInputSource).toContain(
      'lockedSessionAgentKind ? [lockedSessionAgentKind] : unifiedAgents',
    );
  });

  /**
   * bug4 回归锁。锁定分支用的引擎**必须**是已确认身份,不能是 vendorKey 派生的 agentKind:
   * CCAgentSessionView 的 vendorKey 走 dbToMakerAgentKind(session?.agentKind),session 未到
   * (冷启动 / 直链 / 远程列表未回流 / sessionService.get 失败被 catch 吞掉)时回退成 'cc';
   * 同一窗口里 sessionOrcaRole 是 undefined(≠ null)→ sessionAgentSwitchSupported=false →
   * 没有 sessionEngineFilter → 正好落进锁定分支。两者叠加 = Codex 会话摆出一张纯 Claude
   * 列表,且此时没有跨引擎兜底,点任意一行都会把 Claude 模型塞进 Codex 会话。
   */
  it('never locks the union list to a guessed engine before session identity resolves', () => {
    expect(chatInputSource).toContain(
      'const sessionEngineConfirmed = !sessionId || runtimeAgentKind != null;',
    );
    expect(chatInputSource).toContain(
      'inSessionEngineLocked && sessionEngineConfirmed ? (runtimeAgentKind ?? agentKind) : null',
    );
    // 防复活:锁定分支不得再直接读 vendorKey 派生的 agentKind。
    expect(chatInputSource).not.toContain(
      'inSessionEngineLocked && agentKind ? [agentKind] : unifiedAgents',
    );
    expect(chatInputSource).not.toContain(
      '(!inSessionEngineLocked || agentKind !== null)',
    );
  });

  /**
   * bug7:composer pill 不再写 harness 名字文本,改「模型名 + 引擎小标 + 思考深度」。
   * 引擎取值必须与 agentIdentity 同源 —— 会话身份没加载完就不画,绝不拿 vendorKey 的
   * Claude Code 回退冒充(那正是 bug4 的病根,同一个回退不能在 pill 上复发)。
   */
  it('renders the composer pill engine as a mark sourced from the confirmed identity', () => {
    const selectorStart = chatInputSource.lastIndexOf('<ModelSelector');
    const selectorBlock = chatInputSource.slice(
      selectorStart,
      chatInputSource.indexOf('/>', selectorStart) + 2,
    );
    // original 形态(三档并存)不画引擎小标:老 pill 用 harness 名字文本,两代形态不混。
    expect(selectorBlock).toContain(
      'engineMarkVendor={unifiedPanelActive ? composerEngineMarkVendor : null}',
    );
    expect(chatInputSource).toContain(
      "resolveModelSelectorAgentIdentity(runtimeAgentKind, agentSwitchIntent?.target)?.vendorKey ??",
    );
    // 草稿没有 session 身份可言,当前引擎就是 vendorKey。
    expect(chatInputSource).toContain(': (vendorKey ?? null);');
  });

  it('falls back to the legacy panel only when the controlled device has no provider catalog', () => {
    // device-link 老被控端 capabilities-only:联合列表的数据源是供应商目录,没有目录
    // 就是一张空列表。判据必须是结构化的 unsupported,不是 providers.length===0
    // (后者在加载中恒成立,会让面板每次打开先闪一下旧布局)。
    expect(chatInputSource).toContain(
      'const unifiedModelPanelEnabled = !deviceLinkDeviceId || !remoteProviders.unsupported;',
    );
  });

  /**
   * Fast 的跨引擎口径(2026-08-17 review 改版):**只认面板显式给的目标值**。
   * 面板交出来的 `fast` 是按目标引擎解析并过完能力门控的配置(收藏副本 / 恢复推荐的
   * 显式关),显式给值(含 false)必须原样进 overrides;缺省才由 performAgentSwitch 按
   * 目标重解析。**旧引擎的实时 fastMode(本组件同名 state)在两条路上都不得进 payload**——
   * 那是最初版锁住的语义,改版后仍然成立。
   */
  it('passes only the panel-resolved target fast into the cross-engine switch payload', () => {
    const start = chatInputSource.indexOf('const sessionEngineFilter = useMemo(');
    expect(start).toBeGreaterThan(-1);
    const block = chatInputSource.slice(start, chatInputSource.indexOf('}, [', start));
    // 确认弹窗照旧(同一份 confirmAgentBrowseSwitch,含「不再提示」偏好);**有意变更**
    // (Chris 2026-08-19):现在把**本次目标引擎**交给确认门 —— 「已确认过就不再问」的判据
    // 收窄成「已有指向该目标的意图」,否则任何残留意图都会让确认框永久静默。
    expect(block).toContain('confirmAgentBrowseSwitch(targetAgent)');
    // 切换事务照旧;effort 显式带上(用户看着点下去的档)。
    expect(block).toContain('performAgentSwitchRef.current(');
    expect(block).toContain('...(effort ? { effort } : {})');
    // 显式目标 fast 进 overrides —— 判据必须是 `!== undefined`,不能是 truthy:
    // 收藏「Fast 关」(false)也要能压过目标记忆里残留的「开」。
    expect(block).toContain('...(fast !== undefined ? { fastMode: fast } : {})');
    // 防复活:块内所有 fastMode 出现处只允许「fastMode: fast」这一种形态 —— 本组件自己的
    // 实时 Fast state 不得被塞进 payload。
    expect(block).not.toMatch(/fastMode(?!: fast\b)/);
  });

  /**
   * 待切换意图期的引擎口径(2026-08-17 review):跨引擎意图登记后、真切换落地前,
   * activeModel / activeEffort / fastMode / activeProviderId 展示的全是意图目标值,统一面板
   * 的 currentAgent 必须同口径取**意图目标** —— 钉在旧 vendorKey 会让浮层摆出旧引擎的
   * 档位集合,而意图期的回调(performAgentSwitch(intent.target, …))按目标能力校验,
   * 用户点的档位被静默回落。
   */
  it('passes unresolved runtime identity through instead of falling back to the intent target', () => {
    const start = chatInputSource.indexOf('const sessionEngineFilter = useMemo(');
    expect(start).toBeGreaterThan(-1);
    const block = chatInputSource.slice(start, chatInputSource.indexOf('}, [', start));
    expect(block).toContain('runtimeAgent: runtimeAgentKind ?? undefined');
    expect(block).not.toContain('runtimeAgentKind ?? currentAgent');
    expect(block).not.toContain('runtimeAgentKind ?? vendorKeyToAgentKind');
  });

  it('prefers the pending switch intent target as the unified panel session agent', () => {
    expect(chatInputSource).toContain(
      'const intentTargetAgent = agentSwitchIntent?.target ?? null;',
    );
    expect(chatInputSource).toContain(
      'const currentAgent = intentTargetAgent ?? vendorKeyToAgentKind(vendorKey);',
    );
  });

  /**
   * 会话收藏锚点的记录口径(2026-08-17 review 第三轮 G4 + 第四轮 K3)。
   * 两条都得锁住:**真成功才记**(取消 / 事务失败时这次选择根本没发生),以及**记的是入参
   * 里的 uid + 事务后的目标值** —— 跨引擎编辑一条收藏会连带换引擎与 wire id,拿旧值记会让
   * 派生校验永远对不上,锚点等于白记。
   */
  it('records the session favorite anchor from the transaction payload, only on success', () => {
    const start = chatInputSource.indexOf('const sessionEngineFilter = useMemo(');
    expect(start).toBeGreaterThan(-1);
    const block = chatInputSource.slice(start, chatInputSource.indexOf('}, [', start));
    // 入参里带锚点,缺省 null(选普通模型行 / 恢复推荐 / 删收藏都显式传 null)。
    expect(block).toContain('favoriteUid = null,');
    // 只在事务真成功后才记。
    expect(block).toContain('if (applied) {');
    expect(block).toContain('setSessionFavoriteAnchor(');
    // 快照取事务后的目标值(targetAgent / modelId / providerId 都是这次切过去的那一份)。
    expect(block).toContain('uid: favoriteUid,');
    expect(block).toContain('wireModelId: modelId,');
    expect(block).toContain('engine: agentKindToVendor(targetAgent),');
    expect(block).toContain('providerId,');
    // 勾选只认 uid(Chris 2026-08-20):不拿正在跑的来源去对副本。
    expect(chatInputSource).toContain('sessionFavoriteAnchor?.uid ?? null');
    expect(chatInputSource).not.toContain(
      'sessionFavoriteAnchor.providerId === activeProviderId &&',
    );
  });

  /**
   * 合并行之后的 **id 口径锁**(数据层把同一模型的多引擎条目合并成一行,行 id 是归一化 id,
   * 每个引擎真正能发的是各自的 wireModelId)。
   *
   * 这条锁的存在理由是"有活错误":拿归一化行 id 去发请求,首条消息就路由到一个目标引擎目录
   * 里不存在的 model id。接线层的职责很简单 —— **对上游给的 id 零加工**,并且绝不把
   * rowModelId 当发送 id 用。
   */
  it('never uses the normalized row id as a send / memory id', () => {
    // 1. 跨引擎路径:modelId 原样进切换事务,中间不套任何 id 加工函数。
    const filterStart = chatInputSource.indexOf('const sessionEngineFilter = useMemo(');
    expect(filterStart).toBeGreaterThan(-1);
    const filterBlock = chatInputSource.slice(filterStart, chatInputSource.indexOf('}, [', filterStart));
    expect(filterBlock).toContain('performAgentSwitchRef.current(');
    expect(filterBlock).toContain('modelId,');
    expect(filterBlock).not.toContain('rowModelId');

    // 2. 草稿直通路径:记忆键与交给草稿层的 model 都用 selection.modelId(wire id)。
    const draftStart = chatInputSource.indexOf('const handleUnifiedDraftSelect = useCallback(');
    expect(draftStart).toBeGreaterThan(-1);
    const draftBlock = chatInputSource.slice(
      draftStart,
      chatInputSource.indexOf('[sessionId, settingsLocked, modelMemory, onUnifiedDraftSelect]', draftStart),
    );
    expect(draftBlock).toContain('modelId: selection.modelId,');
    // rowModelId 只在类型声明与注释里出现,**不得**出现在任何写入实参上。
    expect(draftBlock).not.toContain('selection.rowModelId');
    for (const write of [
      'modelMemory?.setEffort(',
      'modelMemory?.setFast(targetKind, selection.providerId, selection.modelId, selection.fast)',
    ]) {
      expect(draftBlock).toContain(write);
    }
  });

  it('feeds the selector the session/draft wire id as the selected model', () => {
    const selectorStart = chatInputSource.lastIndexOf('<ModelSelector');
    const selectorBlock = chatInputSource.slice(
      selectorStart,
      chatInputSource.indexOf('/>', selectorStart) + 2,
    );
    // activeModel 的三个来源(agentSwitchIntent / pendingRemoteSwitch / initialModel)全是
    // 会话或草稿持有的 wire id;这里不得改成面板的行 id。
    expect(selectorBlock).toContain('modelId={activeModel}');
    expect(selectorBlock).not.toContain('rowModelId');
  });
});
