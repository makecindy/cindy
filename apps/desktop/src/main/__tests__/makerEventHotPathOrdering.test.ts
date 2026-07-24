/**
 * makerEventHotPathOrdering.test.ts
 * ---------------------------------------------------------------------------
 * maker:event 是每个 agent 事件都会经过的 main→renderer hot path。这里用源码
 * 契约守住顺序：先把事件广播给 renderer，再做 usage/context 这类同步 SQLite
 * 或额外广播 side effect，避免 turn 结束时把 final/done 送达延后。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourcePath = resolve(__dirname, '..', 'maker-ipc', 'register.ts');
const source = readFileSync(sourcePath, 'utf8').replace(/\r\n?/g, '\n');
const usageSourcePath = resolve(__dirname, '..', 'maker-ipc', 'usage.ts');
const usageSource = readFileSync(usageSourcePath, 'utf8').replace(/\r\n?/g, '\n');

describe('maker:event hot path ordering', () => {
  it('broadcasts EVENT before usage/context/island/idle side effects', () => {
    const wireSessionSource = extractWireSessionSource();

    const broadcastIndex = wireSessionSource.indexOf('broadcastToAllWindows(MAKER_PUSH.EVENT');
    expect(broadcastIndex).toBeGreaterThanOrEqual(0);

    for (const sideEffect of [
      'recordSessionContextSnapshot(',
      'recordCodexAccountUsageSnapshot(',
      'recordTurnSpend(',
      'recordSessionTurnSpend(',
      'recordCodexTurnUsage(',
      'handleAgentIslandEventAfterBroadcast(',
      'sessionTurnActivityTracker.scheduleIdleAfterStatusBroadcast(',
      'sessionTurnActivityTracker.scheduleIdleAfterTerminalBroadcast(',
    ]) {
      const indices = [...wireSessionSource.matchAll(new RegExp(escapeRegExp(sideEffect), 'g'))]
        .map((match) => match.index)
        .filter((index): index is number => typeof index === 'number');
      expect(indices.length, `${sideEffect} should be present`).toBeGreaterThan(0);
      expect(indices.every((index) => index > broadcastIndex), `${sideEffect} must be after EVENT broadcast`).toBe(true);
    }
    expect(wireSessionSource.slice(0, broadcastIndex)).not.toContain('handleAgentEvent(sessionMetaForIsland');
  });

  it('defers remote auth island errors until the renderer reports retry failure', () => {
    const wireSessionSource = extractWireSessionSource();
    const deferredHandler = source.match(
      /ipcMain\.handle\(MAKER_INVOKE\.PERSIST_TURN_ERROR_DEFERRED,[\s\S]*?\n {2}\}\);/,
    )?.[0];

    expect(source).toContain('function isRemoteAuthRetryErrorEvent(');
    expect(source).toContain('service.deferRemoteAuthRetryError(meta, event);');
    expect(wireSessionSource).toContain('isRemoteAuthRetry = isRemoteAuthRetryErrorEvent(session, event);');
    expect(deferredHandler).toBeTruthy();
    expect(deferredHandler).toContain('getAgentIslandService()?.resolveDeferredRemoteAuthRetryError(sid);');
    expectOrder(
      deferredHandler ?? '',
      'onTurnErrorEvent(sid, errData, agentMeta);',
      'getAgentIslandService()?.resolveDeferredRemoteAuthRetryError(sid);',
    );
  });

  it('only status/done/error paths request idle restore', () => {
    const wireSessionSource = extractWireSessionSource();
    const statusIdleAssignments = [...wireSessionSource.matchAll(/shouldMarkTurnStatusIdleAfterBroadcast = true;/g)]
      .map((match) => match.index)
      .filter((index): index is number => typeof index === 'number');
    const terminalIdleAssignments = [...wireSessionSource.matchAll(/shouldMarkTurnTerminalIdleAfterBroadcast = true;/g)]
      .map((match) => match.index)
      .filter((index): index is number => typeof index === 'number');

    expect(statusIdleAssignments).toHaveLength(1);
    expect(terminalIdleAssignments).toHaveLength(2);

    // 回看窗口要盖住赋值点与所属 if 条件之间的声明/注释(done 分支里 silent-stop
    // 的 isSilentStopDone 判定 + 设计注释就有 ~500 字符),太窄会把仍在正确分支内的
    // 赋值误判成"脱离 done 路径"。
    const CONTEXT_LOOKBACK = 700;
    const statusContexts = statusIdleAssignments.map((index) =>
      wireSessionSource.slice(Math.max(0, index - CONTEXT_LOOKBACK), index + 'shouldMarkTurnStatusIdleAfterBroadcast = true;'.length),
    );
    const terminalContexts = terminalIdleAssignments.map((index) =>
      wireSessionSource.slice(Math.max(0, index - CONTEXT_LOOKBACK), index + 'shouldMarkTurnTerminalIdleAfterBroadcast = true;'.length),
    );

    expect(statusContexts.some((context) => context.includes('data.isRunning === false'))).toBe(true);
    expect(terminalContexts.some((context) => context.includes("event.type === 'done'"))).toBe(true);
    expect(terminalContexts.some((context) => context.includes('isTerminalTurnErrorEvent(event)'))).toBe(true);
    expect([...statusContexts, ...terminalContexts].join('\n')).not.toContain("event.type === 'error'");
  });

  it('does not persist remote Codex account snapshots into local account usage', () => {
    const wireSessionSource = extractWireSessionSource();
    expect(wireSessionSource).toContain(
      "event.type === 'account_usage' && event.source === 'codex' && !session.remoteHostId",
    );
  });

  it('fires git snapshots only from post-broadcast done events', () => {
    const wireSessionSource = extractWireSessionSource();
    const broadcastIndex = wireSessionSource.indexOf('broadcastToAllWindows(MAKER_PUSH.EVENT');
    const snapshotIndex = wireSessionSource.indexOf('void gitSnapshotCoordinator?.onTurnEnd(session.id);');
    const doneBlockIndex = wireSessionSource.indexOf("if (event.type === 'done') {", broadcastIndex);
    const beforeBroadcast = wireSessionSource.slice(0, broadcastIndex);

    expect(snapshotIndex).toBeGreaterThan(broadcastIndex);
    expect(beforeBroadcast).not.toContain('gitSnapshotCoordinator?.onTurnEnd');
    expect(doneBlockIndex).toBeGreaterThanOrEqual(0);
    expect(snapshotIndex).toBeGreaterThan(doneBlockIndex);
  });

  it('uses status turn-start snapshots only as a fallback when no baseline is pending', () => {
    const wireSessionSource = extractWireSessionSource();
    const turnStartIndex = wireSessionSource.indexOf('gitSnapshotCoordinator?.onTurnStart(session.id);');
    const pendingCheckIndex = wireSessionSource.indexOf('gitSnapshotCoordinator?.hasPendingTurnStart(session.id)');

    expect(turnStartIndex).toBeGreaterThanOrEqual(0);
    expect(pendingCheckIndex).toBeGreaterThanOrEqual(0);
    expect(pendingCheckIndex).toBeLessThan(turnStartIndex);
  });

  it('clears pending git snapshot baselines only after terminal error broadcast', () => {
    const wireSessionSource = extractWireSessionSource();
    const broadcastIndex = wireSessionSource.indexOf('broadcastToAllWindows(MAKER_PUSH.EVENT');
    const abortIndex = wireSessionSource.indexOf('gitSnapshotCoordinator?.onTurnAbort(session.id);');
    const beforeBroadcast = wireSessionSource.slice(0, broadcastIndex);
    const abortContext = wireSessionSource.slice(Math.max(0, abortIndex - 140), abortIndex + 80);

    expect(abortIndex).toBeGreaterThan(broadcastIndex);
    expect(beforeBroadcast).not.toContain('gitSnapshotCoordinator?.onTurnAbort');
    expect(abortContext).toContain('isTerminalTurnErrorEvent(event)');
  });

  it('isolates Agent Island interaction updates after renderer delivery', () => {
    const interactionListenerSource = extractInstallDesktopInteractionListenerSource();
    const broadcastIndex = interactionListenerSource.indexOf('broadcastToAllWindows(MAKER_PUSH.INTERACTION_REQUEST');
    const pendingIndex = interactionListenerSource.indexOf('pendingInteractionResolvers.set(req.requestId, entry);');
    const islandIndex = interactionListenerSource.indexOf('handleAgentIslandInteractionAfterBroadcast(');

    expect(broadcastIndex).toBeGreaterThanOrEqual(0);
    expect(pendingIndex).toBeGreaterThan(broadcastIndex);
    expect(islandIndex).toBeGreaterThan(pendingIndex);
    expect(interactionListenerSource.slice(0, broadcastIndex)).not.toContain('handleInteractionRequest(');
    expect(source).toContain('Agent Island interaction update failed after maker interaction broadcast');
  });

  it('clears git snapshot coordinator state when sessions close', () => {
    const wireSessionSource = extractWireSessionSource();
    const closedBlock = wireSessionSource.slice(wireSessionSource.indexOf("if (status === 'closed') {"));

    expect(closedBlock).toContain('gitSnapshotCoordinator?.onSessionClosed(session.id);');
    expectOrder(
      closedBlock,
      'agentInputCoordinatorHolder?.onSessionClosed(session.id);',
      'gitSnapshotCoordinator?.onSessionClosed(session.id);',
    );
  });

  it('clears Agent Island after mandatory closed-session cleanup', () => {
    const wireSessionSource = extractWireSessionSource();
    const closedBlock = wireSessionSource.slice(wireSessionSource.indexOf("if (status === 'closed') {"));
    const closeSessionHandler = source.match(
      /ipcMain\.handle\(MAKER_INVOKE\.CLOSE_SESSION,[\s\S]*?\n {2}\}\);/,
    )?.[0];

    expect(closedBlock).toContain('handleAgentIslandSessionClosedAfterCleanup(session.id);');
    expectOrder(
      closedBlock,
      "cleanupPendingInteractionsForSession(session.id, 'session_closed');",
      'handleAgentIslandSessionClosedAfterCleanup(session.id);',
    );
    expect(source).toContain('Agent Island session close cleanup failed after mandatory session cleanup');
    expect(closeSessionHandler).toBeTruthy();
    expect(closeSessionHandler).not.toContain('handleSessionClosed');
  });

  it('keeps Codex subscription value out of real session cost totals', () => {
    const wireSessionSource = extractWireSessionSource();
    const codexDoneIndex = wireSessionSource.indexOf("event.type === 'done' && event.source === 'codex'");
    expect(codexDoneIndex).toBeGreaterThanOrEqual(0);

    const codexDoneSource = wireSessionSource.slice(codexDoneIndex);
    expect(codexDoneSource).toContain('const sessionProvider = getSessionProvider(session.id);');
    expect(codexDoneSource).toContain('const isRemoteCodexSession = Boolean(session.remoteHostId);');
    expect(codexDoneSource).toContain('const codexAuthInjection = isRemoteCodexSession ? null : getCodexProxyAuthInjection();');
    expect(wireSessionSource).toContain('!turnModelPromiseBySession.has(session.id)');
    expect(wireSessionSource).toContain('turnModelPromiseBySession.set(session.id, readSessionModelForUsage(session.id));');
    expect(codexDoneSource).toContain('const modelPromise = turnModelPromiseBySession.get(session.id) ?? readSessionModelForUsage(session.id);');
    expect(codexDoneSource).toContain('turnModelPromiseBySession.delete(session.id);');
    expect(codexDoneSource).not.toContain('hasCodexOAuthLogin()');
    expect(codexDoneSource).toContain('promptTokens + completionTokens + cachedTokens');
    expect(codexDoneSource).not.toContain('promptTokens + completionTokens + reasoningTokens + cachedTokens');
    expect(codexDoneSource).toContain('const isCodexBudgetRoute = pricingModel.startsWith(\'codex/\');');
    expect(codexDoneSource).toContain('const isCodexXaiProviderRoute = pricingModel.startsWith(XAI_MODEL_PREFIX);');
    expect(codexDoneSource).toContain('const hasGatewayKey = Boolean(readClaudeApiKey());');
    expect(codexDoneSource).toContain('const hasEffectiveGatewayRoute =');
    expect(codexDoneSource).toContain('(sessionProvider === \'xd\' && hasGatewayKey)');
    expect(codexDoneSource).toContain('const isSubscriptionValue = isRemoteCodexSession ||');
    expect(codexDoneSource).toContain('isCodexXaiProviderRoute ||');
    expect(codexDoneSource).toContain("(codexAuthInjection === 'oauth-bearer' && !hasEffectiveGatewayRoute)");
    expect(codexDoneSource).toContain('const modelUsageKey = isSubscriptionValue');
    expect(codexDoneSource).toContain('? codexSubscriptionUsageModelKey(pricingModel)');
    expect(codexDoneSource).toContain(': codexApiUsageModelKey(pricingModel)');
    expect(codexDoneSource).toContain('const price = isCodexXaiProviderRoute');
    expect(codexDoneSource).toContain('? getSubscriptionDirectValuePrice(pricingModel)');
    expect(codexDoneSource).toContain('? getCodexSubscriptionValuePrice(pricingModel, pricing)');
    expect(codexDoneSource).toContain(': pricing?.[pricingModel]');
    expect(codexDoneSource).toContain('const pricing = isSubscriptionValue && !isCodexXaiProviderRoute');
    expect(codexDoneSource).toContain('? await getModelPricing()');
    expect(codexDoneSource).toContain(': await getModelPricingForModel(pricingModel)');
    expect(codexDoneSource).toMatch(
      /if \(!isSubscriptionValue\) \{\s*void recordTurnSpend\(cost\);\s*void recordSessionTurnSpend\(session\.id, cost\);/,
    );
    expect(codexDoneSource).toMatch(
      /await recordModelTurnUsage\(\{\s*agentKind: 'codex',\s*model: modelUsageKey,\s*costUsdDelta: 0,\s*inputTokensDelta: promptTokens,\s*outputTokensDelta: completionTokens,\s*cacheReadTokensDelta: cachedTokens,\s*cacheCreateTokensDelta: 0,\s*\}\)\.finally\(\(\) => rebroadcastCodexTodayUsage\(\)\);[\s\S]*?const pricing = isSubscriptionValue && !isCodexXaiProviderRoute/,
    );
    expect(codexDoneSource).toMatch(
      /await recordModelTurnUsage\(\{\s*agentKind: 'codex',\s*model: modelUsageKey,\s*costUsdDelta: cost,\s*inputTokensDelta: 0,\s*outputTokensDelta: 0,\s*cacheReadTokensDelta: 0,\s*cacheCreateTokensDelta: 0,\s*\}\);/,
    );
    const costRecordIndex = codexDoneSource.indexOf('void recordTurnSpend(cost);');
    const modelCostRecordIndex = codexDoneSource.indexOf('costUsdDelta: cost,');
    const messageCostGuardIndex = codexDoneSource.indexOf('if (turnAssistantPersistId)');
    expect(costRecordIndex).toBeGreaterThanOrEqual(0);
    expect(modelCostRecordIndex).toBeGreaterThanOrEqual(0);
    expect(modelCostRecordIndex).toBeGreaterThan(codexDoneSource.indexOf('const pricing = isSubscriptionValue && !isCodexXaiProviderRoute'));
    expect(messageCostGuardIndex).toBeGreaterThan(costRecordIndex);
    expect(codexDoneSource).toContain('isEstimate: isSubscriptionValue');
    expect(codexDoneSource).toContain('if (!isRemoteCodexSession &&');
    expect(codexDoneSource).toContain("!model.startsWith(XAI_MODEL_PREFIX) &&");
    expect(codexDoneSource).toContain("(codexAuthInjection === 'env-key' || model.startsWith('codex/') || (sessionProvider === 'xd' && hasGatewayKey))");
    expect(codexDoneSource).not.toContain("sessionProvider !== 'xai'");
    expect(codexDoneSource).not.toContain('isEstimate: true');
  });

  it('claude-code 费用走 HYBRID 定价 (gateway 重算 + total_cost_usd 窄兜底) after EVENT broadcast', () => {
    const wireSessionSource = extractWireSessionSource();
    const claudeDoneIndex = wireSessionSource.indexOf("event.type === 'done' && event.source === 'claude-code'");
    const codexDoneIndex = wireSessionSource.indexOf("event.type === 'done' && event.source === 'codex'");
    expect(claudeDoneIndex).toBeGreaterThanOrEqual(0);
    expect(codexDoneIndex).toBeGreaterThan(claudeDoneIndex);

    // 仅取 claude-code 块 (到 codex 块前)。
    const claudeDoneSource = wireSessionSource.slice(claudeDoneIndex, codexDoneIndex);
    // 主路径: 逐模型 HYBRID 定价 (Anthropic→SDK, 非 Anthropic→gateway), 四个 sink 同源同值。
    expect(claudeDoneSource).toContain('const gatewayPricingModels = Array.from(new Set(');
    expect(claudeDoneSource).toContain('.filter((model) => !isAnthropicModel(model) && !isSubscriptionDirectModel(model))');
    expect(claudeDoneSource).toContain('for (const model of gatewayPricingModels) {');
    expect(claudeDoneSource).toContain('pricing = await getModelPricingForModel(model);');
    expect(claudeDoneSource).not.toContain('const gatewayPricingModel = deltas');
    expect(claudeDoneSource).not.toContain('const pricing = needsPricing ? await getModelPricing() : null;');
    expect(claudeDoneSource).toContain('const { turnTotalUsd, perModel } = resolveClaudeTurnCostSinks(deltas, pricing);');
    expect(claudeDoneSource).toContain('recordTurnSpend(turnTotalUsd);');
    expect(claudeDoneSource).toContain('recordSessionTurnSpend(session.id, turnTotalUsd);');
    expect(claudeDoneSource).toContain('costUsdDelta: m.costUsd,');
    // 订阅轮 (Claude Anthropic 订阅或 bridge 订阅直连) 打 #billing=subscription 标记,
    // 仪表盘按订阅估算价折算; 其余轮仍写归一化裸 id。
    expect(claudeDoneSource).toContain(
      'model: isClaudeSubscriptionValueRow ? claudeSubscriptionUsageModelKey(m.model) : m.model,',
    );
    expect(claudeDoneSource).toContain(
      "isClaudeSubscriptionSession && m.costUsd === 0 && isAnthropicModel(m.model)",
    );
    expect(claudeDoneSource).toContain(
      "m.source === 'subscription' && isSubscriptionDirectModel(m.model)",
    );
    // 订阅判定对齐 proxy 路由: 显式选 Anthropic, 或默认路由优先按 observed route, 未观察再回落无网关 key 启发式
    expect(claudeDoneSource).toContain("sessionProviderForBilling === 'anthropic'");
    expect(claudeDoneSource).toContain('const observedClaudeRoute =');
    expect(claudeDoneSource).toContain('readClaudeSessionRoute(session.id)');
    expect(claudeDoneSource).toContain(
      "observedClaudeRoute === 'subscription'",
    );
    expect(claudeDoneSource).toContain(
      ': !readClaudeApiKey()',
    );
    // 纯订阅轮无 recordTurnSpend push, 模型行落库后重广播今日 spend 触发仪表盘刷新
    expect(claudeDoneSource).toContain(
      'void Promise.allSettled(modelUsageWrites).then(() => rebroadcastTodaySpend());',
    );
    // 保留 #216 的 tooltip token/cache 明细。
    expect(claudeDoneSource).toContain('buildClaudeTurnUsageDetails(');
    // 窄兜底: modelUsage 缺失时仍用 total_cost_usd delta 记总额, 别漏整轮 (review #4)。
    expect(claudeDoneSource).toContain('const rawDelta = Math.max(0, cumulative - prevReportedCost);');
  });

  it('refreshes Claude credential cache before dropping mismatched header snapshots', () => {
    const listenerSource = usageSource.match(
      /setClaudeRateLimitHeadersListener\(\(snapshot, requestBearerToken\) => \{[\s\S]*?\n {2}\}\);/,
    )?.[0];
    expect(listenerSource).toBeTruthy();
    if (!listenerSource) return;

    expect(listenerSource).toContain('let currentToken = _currentClaudeToken;');
    expect(listenerSource).toContain('currentToken = readClaudeCredentialsInfo()?.accessToken ?? null;');
    expectOrder(
      listenerSource,
      'currentToken = readClaudeCredentialsInfo()?.accessToken ?? null;',
      'if (requestBearerToken !== currentToken) return false;',
    );
  });
});

function extractWireSessionSource(): string {
  const wireSessionSource = source.match(
    /export function wireSessionToIpc\([\s\S]*?export const wireSessionToIpcExternal = wireSessionToIpc;/,
  )?.[0];
  expect(wireSessionSource).toBeTruthy();
  if (!wireSessionSource) {
    throw new Error('wireSessionToIpc source block not found');
  }
  return wireSessionSource;
}

function extractInstallDesktopInteractionListenerSource(): string {
  const listenerSource = source.match(
    /export function installDesktopInteractionListener\([\s\S]*?\n}\n\n\/\*\*\n \* 把 session 接进 IPC 转发链路/,
  )?.[0];
  expect(listenerSource).toBeTruthy();
  if (!listenerSource) {
    throw new Error('installDesktopInteractionListener source block not found');
  }
  return listenerSource;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function expectOrder(sourceBlock: string, firstNeedle: string, secondNeedle: string): void {
  const first = sourceBlock.indexOf(firstNeedle);
  const second = sourceBlock.indexOf(secondNeedle);
  expect(first).toBeGreaterThanOrEqual(0);
  expect(second).toBeGreaterThanOrEqual(0);
  expect(first).toBeLessThan(second);
}
