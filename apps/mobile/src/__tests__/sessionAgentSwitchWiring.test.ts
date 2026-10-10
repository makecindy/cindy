import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n');
}

describe('new task remote Agent wiring', () => {
  it('lists remote and shared providers and creates the task with the Agent there', () => {
    const source = readSource('app/sessions/new.tsx');
    // 被控电脑支持远程 Agent 时,模型列表接上其他电脑与分享的供应商;协同草稿与之互斥。
    expect(source).toContain('const remoteAgentCatalogs = useRemoteAgentCatalogs({');
    expect(source).toContain('...(remoteAgentSupported && !collabDraft');
    expect(source).toContain('remote: { catalogs: remoteAgentCatalogs, selectedDeviceId: remoteAgentPick?.deviceId ?? null }');
    expect(source).toContain('const collabEligible = isOrcaCollabEligible(collabTarget) && remoteAgentPick === null;');
    // 选中远程行单独记;选本机行清掉。
    const select = source.slice(source.indexOf('const selectUnifiedModel = useCallback'), source.indexOf('const selectFlatModel'));
    expect(select).toContain('const remoteDeviceId = source?.deviceId ?? null;');
    expect(select).toContain('setRemoteAgentChoice({');
    expect(select).toContain('setRemoteAgentChoice(null);');
    // 普通创建与目标模式都把远程选择落进草稿,且不按被控电脑的目录 / 登录拦。
    expect(source.split('applyRemoteAgentPick(draft, remoteAgentPick)')).toHaveLength(3);
    expect(source.split('const runGuard = () => effectiveDraft.agentDeviceId ? Promise.resolve({')).toHaveLength(3);
    expect(source).toContain('confirmUnauthenticated: effectiveDraft.agentDeviceId');
    expect(source).toContain("agentAuthVerdict === 'unauthenticated' || remoteAgentPick");
    // 恢复草稿时把 Agent 所在电脑拆回远程选择。
    expect(source).toContain('const { agentDeviceId, ...recovered } = saved;');
  });
});

describe('session Agent switch UI wiring', () => {
  it('locks guest model controls while preserving message and stop controls', () => {
    const source = readSource('app/sessions/[sessionId].tsx');
    const modelAccess = source.slice(source.indexOf('const canConfigureSessionModel'), source.indexOf('// 共享模型自造'));
    expect(modelAccess).toContain('canUseRemoteSessionControls');
    expect(modelAccess).toContain('!sessionManagedByHost');
    expect(modelAccess).toContain('!isSharedTaskPeer(deviceId)');
    expect(source).toContain('disabled={controlBusy || !canConfigureSessionModel}');
    expect(source).toContain('visible={modelSheetOpen && canConfigureSessionModel}');
    expect(source).toContain('if (!canConfigureSessionModel) setModelSheetOpen(false);');
    for (const [start, end] of [
      ['const setComposerModel', '// 选行 = 原子切'],
      ['const changeComposerSelectedEffort', 'const changeComposerSelectedFastMode'],
      ['const changeComposerSelectedFastMode', 'const toggleComposerModelPicker'],
      ['const toggleComposerModelPicker', '// 账号限额按需拉取'],
    ]) {
      const handler = source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
      expect(handler).toContain('if (!canConfigureSessionModel)');
    }
    const writer = source.slice(source.indexOf('const writeSessionAgentSwitchIntent'), source.indexOf('const setComposerModel'));
    expect(writer).toContain('if (!deviceId || controlBusy || isSharedTaskPeer(deviceId)) return false;');
    const controls = source.slice(source.indexOf('const canUseComposer ='), source.indexOf('const canConfigureSessionModel'));
    expect(controls).not.toContain('isSharedTaskPeer');
  });

  it('keeps pending intent separate from the persisted session fields and rehydrates it', () => {
    const source = readSource('app/sessions/[sessionId].tsx');
    expect(source).toContain('maker.getSessionAgentSwitchIntent(sessionId)');
    expect(source).toContain('maker.switchSessionAgent(');
    expect(source).toContain('agentSwitchIntent: normalizeSessionAgentSwitchIntent(result)');
    expect(source).toContain('agentSwitch={sessionAgentSwitchSupported ? {');
    expect(source).toContain('confirmMobileSessionAgentSwitch(next, !!agentSwitchIntent)');
    expect(source).toContain('targetAgentKind: modelSheetAgentKind');
    expect(source).toContain('...(agentSwitchIntent ? { agentSwitchIntent: null } : {})');
  });

  it('lists other computers in the model sheet and moves the Agent only after confirmation', () => {
    const source = readSource('app/sessions/[sessionId].tsx');
    const writerStart = source.indexOf('const writeSessionAgentSwitchIntent = useCallback');
    const writer = source.slice(writerStart, source.indexOf('// Context 面板', writerStart));
    // 唯一写出口把 intent 的位置作为第 7 参转给被控端;没有位置时不发(旧 6 参 wire)。
    expect(writer).toContain('nextIntent.agentDeviceId !== undefined');
    expect(writer).toContain('? { agentDeviceId: nextIntent.agentDeviceId }');
    // 共享任务访客不能挪 Agent 位置,SSH / Orca 不支持切换,旧被控端不投影位置字段。
    expect(source).toContain('const agentLocationMovable = sessionAgentSwitchSupported');
    expect(source).toContain("&& !isSharedTaskPeer(deviceId)");
    expect(source).toContain("Object.prototype.hasOwnProperty.call(currentSession, 'agentDeviceId')");
    // 模型列表另列其他电脑的供应商,选中态跟着下一条消息时 Agent 所在的电脑。
    expect(source).toContain(
      '? { remote: { catalogs: remoteAgentCatalogs, selectedDeviceId: nextAgentDeviceId } }',
    );
    // 顶部常驻说明已去掉,由换电脑前的二次确认代替。
    expect(source).not.toContain('notice={agentLocationNotice}');

    const rowSelector = source.slice(
      source.indexOf('const selectComposerModelRow'),
      source.indexOf('const selectUnifiedComposerModel'),
    );
    const unifiedSelector = source.slice(
      source.indexOf('const selectUnifiedComposerModel'),
      source.indexOf('const selectComposerFlatModel'),
    );
    const flatSelector = source.slice(
      source.indexOf('const selectComposerFlatModel'),
      source.indexOf('const browseComposerModelAgent'),
    );
    for (const selector of [rowSelector, unifiedSelector, flatSelector]) {
      expect(selector).toContain('await confirmAgentLocationForPick({');
      expect(selector).toContain('intent: agentSwitchIntent,');
      // 换电脑的选择走切换意图,而且必须在 setModel 之前分流;取消 = 什么都不改。
      expect(selector).toMatch(/if \(!location(?: \|\| deviceIdRef\.current !== deviceId)?\) return/);
      expect(selector.indexOf('writeSessionAgentSwitchIntent(')).toBeGreaterThan(-1);
      expect(selector.indexOf('writeSessionAgentSwitchIntent(')).toBeLessThan(
        selector.indexOf('setComposerModel('),
      );
    }
    // 被控电脑自己的列表(旧版 / 扁平)只来自被控电脑。
    expect(rowSelector).toContain('catalogDeviceId: null,');
    expect(flatSelector).toContain('catalogDeviceId: null,');
    expect(unifiedSelector).toContain('const catalogDeviceId = source?.deviceId ?? null;');

    // 已登记换位置时,推理强度 / Fast 改的是 intent 本身(带着位置),不是 setEffort / setFastMode。
    const toggles = source.slice(
      source.indexOf('const changeComposerSelectedEffort'),
      source.indexOf('const toggleComposerModelPicker'),
    );
    expect(toggles.match(
      /\(modelSheetAgentKind !== sessionAgentKind \|\| intentChangesAgentLocation\(agentSwitchIntent\)\)/g,
    )).toHaveLength(2);

    // 模型药丸按 Agent 所在电脑的目录显示,带远程标记;读屏标签读出那台电脑。
    expect(source).toContain('providers: composerAgentCatalog.providers,');
    expect(source).toContain('remote={Boolean(nextAgentDeviceId)}');
    expect(source).toContain('accessibilityLabel={composerRuntimeAccessibilityLabel}');
  });

  it('uses the browsed Agent capabilities and selection in the shared model sheet', () => {
    const source = readSource('app/sessions/[sessionId].tsx');
    expect(source).toContain('agentKind={modelSheetAgentKind}');
    expect(source).toContain('capabilities={modelSheetCapabilities}');
    expect(source).toContain('flatOptions={modelSheetRuntimeOptions.modelOptions}');
    expect(source).toContain('selectedProviderId={modelSheetSelection.providerId}');
    expect(source).toContain('agentKind={agentSwitchIntent.targetAgentKind}');
  });

  it('preflights legacy hosts and isolates only rebuild-unsupported preconditions', () => {
    const source = readSource('app/sessions/[sessionId].tsx');
    const rowSelector = source.slice(
      source.indexOf('const selectComposerModelRow'),
      source.indexOf('const selectComposerFlatModel'),
    );
    const flatSelector = source.slice(
      source.indexOf('const selectComposerFlatModel'),
      source.indexOf('const browseComposerModelAgent'),
    );
    const helperStart = source.indexOf('const setComposerModel = useCallback');
    const alertHelper = source.slice(
      source.indexOf('const showRemoteModelWindowUnsupported = useCallback'),
      helperStart,
    );
    const helper = source.slice(
      helperStart,
      source.indexOf('// 选行 = 原子切', helperStart),
    );
    const controlAction = source.slice(
      source.indexOf('const runControlAction = useCallback'),
      source.indexOf('const writeSessionAgentSwitchIntent'),
    );

    const legacyGuard = helper.indexOf('shouldBlockLegacyRemoteModelWindowSwitch({');
    const setModel = helper.indexOf(
      'await maker.setModel(sessionId, args.model, args.providerId, args.selection)',
    );
    expect(legacyGuard).toBeGreaterThan(-1);
    expect(legacyGuard).toBeLessThan(setModel);
    expect(helper.slice(legacyGuard, setModel)).toContain('return false;');
    expect(helper).toContain(
      'hostGuardSupported: modelSheetCapabilities?.supportsModelWindowSwitchGuard === true',
    );
    expect(helper).toContain('agentKind: sessionAgentKind');
    expect(helper).not.toContain('isSsh');
    expect(helper).toContain('contextTokens: currentSession?.contextTokens');
    expect(helper).toContain('currentContextWindow: currentSession?.contextWindow');
    expect(helper).toContain('targetContextWindow: args.targetContextWindow');
    expect(helper).toContain('showRemoteModelWindowUnsupported(args.targetContextWindow);');
    expect(rowSelector).toContain(
      'modelSheetCapabilities?.supportsModelWindowSwitchGuard === true',
    );
    expect(rowSelector).toContain('selection: atomicSelection,');
    expect(rowSelector).toContain('setComposerModel({');
    expect(rowSelector).toContain('if (!applied) return false;');
    expect(rowSelector).toContain('if (!atomicSelection && next.effort');
    expect(rowSelector).toContain('if (!atomicSelection && next.fastMode');
    expect(rowSelector.indexOf('if (!applied) return false;')).toBeLessThan(
      rowSelector.indexOf('await maker.setEffort('),
    );
    expect(rowSelector.indexOf('if (!applied) return false;')).toBeLessThan(
      rowSelector.indexOf('await maker.setFastMode('),
    );
    expect(rowSelector).toContain('targetContextWindow: row.model.contextWindow');
    expect(flatSelector).toContain('reconcileRuntimeDraftWithCapabilities({');
    expect(flatSelector).toContain(
      'modelSheetCapabilities?.supportsModelWindowSwitchGuard === true',
    );
    expect(flatSelector).toContain('targetContextWindow: option.contextWindow');
    expect(flatSelector).toContain('selection: atomicSelection,');
    expect(flatSelector).toContain(
      'atomicSelection?.effort ? { effort: atomicSelection.effort }',
    );
    expect(flatSelector).toContain('{ fastMode: atomicSelection.fastMode }');
    expect(source).not.toContain('confirmMobileModelWindowSwitch');
    expect(source).not.toContain('confirmComposerModelWindowSwitch');
    expect(source).not.toContain('setComposerModelWithFinalWindowConfirmation');
    expect(source).not.toContain('contextWindowConfirmationRequired');
    expect(source).not.toContain('contextTokensForConfirmation');
    expect(source).not.toContain('confirmedContextWindow');
    expect(helper).toContain('const reason = formatRemoteError(err);');
    expect(helper).toContain('const isRemoteModelWindowUnsupported =');
    expect(helper).toContain("reason.includes('remote model-window rebuild is unsupported') ||");
    expect(helper).toContain("reason.includes('remote model-window confirmation is unsupported')");
    expect(helper).toContain('!isPreconditionFailedRemoteError(err) ||');
    expect(helper).toContain('!isRemoteModelWindowUnsupported');
    expect(helper).toContain('throw err;');
    expect(helper).not.toContain('Alert.alert(reason);');
    expect(helper).toContain(
      'showRemoteModelWindowUnsupported(args.targetContextWindow, reason);',
    );
    expect(alertHelper).toContain("t('models.contextWindowSwitch.remoteTitle')");
    expect(alertHelper).toContain("t('models.contextWindowSwitch.remoteDescription', {");
    expect(alertHelper).toContain('used: formatModelWindowTokens(contextTokens)');
    expect(alertHelper).toContain('total: formatModelWindowTokens(targetContextWindow)');
    expect(alertHelper).toContain('pct: Math.round((contextTokens / targetContextWindow) * 100)');
    expect(alertHelper).toContain(': fallbackDescription;');
    expect(alertHelper).toContain(
      "{ text: t('models.contextWindowSwitch.cancel'), style: 'cancel' }",
    );
    // Read-only guest guard plus the two legacy window-switch rejection paths.
    expect(helper.match(/return false;/g)).toHaveLength(3);
    expect(helper).not.toContain('setError(');
    expect(controlAction).toContain('applied === false && rollbackPatch && deviceId');
    expect(controlAction).toContain('setError(formatRemoteError(err));');
  });
});
