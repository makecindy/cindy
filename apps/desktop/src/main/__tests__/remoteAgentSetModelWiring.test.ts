/**
 * Agent 在另一台电脑运行的任务:换模型时不拿本机模型目录去校验那台的模型(那台的 Agent 裁决),
 * 点选仍只记意图、在发送边界落地;建任务与恢复时同样跳过本机路由检查。
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, '../maker-ipc/register.ts'), 'utf8');

function handlerBody(): string {
  const start = source.indexOf('const handleSetModel = async (');
  const end = source.indexOf('applyPiModelSettingsRefresh = async', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('agent-device model selection wiring', () => {
  it('routes agent-device tasks before any local catalog check', () => {
    const body = handlerBody();
    expect(body).toContain('agentDeviceId: sessions.agentDeviceId,');
    const branch = body.indexOf('if (runtimeStatus.agentDeviceId && !runtimeStatus.remoteHostId) {');
    expect(branch).toBeGreaterThan(0);
    const applyLocked = body.indexOf('const applyLocked = async () => {');
    const firstCatalogCheck = body.indexOf('await assertModelRouteUsable(', applyLocked);
    const firstCatalogLookup = body.indexOf('findCatalogModel(', applyLocked);
    expect(branch).toBeGreaterThan(applyLocked);
    expect(branch).toBeLessThan(firstCatalogCheck);
    expect(branch).toBeLessThan(firstCatalogLookup);
  });

  it('keeps picker clicks as intents and applies them through the live session at send time', () => {
    const body = handlerBody();
    const start = source.indexOf('const applyAgentDeviceRuntimeSelection = async');
    const end = source.indexOf('const handleSetModel = async (', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const branch = source.slice(start, end);
    expect(body).toContain('return applyAgentDeviceRuntimeSelection({');
    expect(branch).toMatch(/internalOptions\.source === 'user' && !internalOptions\.applyingUserSelectionOnSend/);
    expect(branch).toContain('agentSwitchPending.set(sessionId, intent);');
    expect(branch).toContain('pendingUntilSend: true');
    expect(branch).toContain('live.requiresModelSwitchRebuild?.(model, { providerId: targetProviderId })');
    expect(branch).toContain('await live.setModel?.(model');
    expect(branch).toContain('await persistSessionFields(sessionId, patch);');
    expect(branch).not.toContain('assertModelRouteUsable');
    expect(branch).not.toContain('getActiveCatalog');
  });

  it('restores the agent computer from the task record when starting', () => {
    const start = source.indexOf('async function bootstrapSession(');
    const body = source.slice(start, start + 4000);
    expect(body).toContain('const agentDeviceId = await readSessionAgentDeviceId(o.id);');
    expect(body).toContain('if (agentDeviceId) o.agentDeviceId = agentDeviceId;');
    expect(body).toContain('const agentOnOtherDevice = Boolean(o.agentDeviceId) && !o.remoteHostId;');
  });

  it('treats a failed task lookup as a local task', () => {
    const start = source.indexOf('async function readSessionAgentDeviceId(');
    const body = source.slice(start, source.indexOf('\n  }\n', start));
    expect(body).toContain('return row?.agentDeviceId && !row.remoteHostId ? row.agentDeviceId : null;');
    expect(body).toMatch(/catch \(error\) \{[\s\S]*treating the task as local[\s\S]*return null;/);
  });

  it('refuses Review for these tasks before collecting evidence', () => {
    const select = source.indexOf('.where(eq(sessions.id, request.sourceSessionId))');
    const guard = source.indexOf('if (source.agentDeviceId) {', select);
    const evidence = source.indexOf('const sourceWorkingDir = source.workingDir;', select);
    expect(select).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(select);
    expect(guard).toBeLessThan(evidence);
    expect(source.slice(guard, evidence)).toContain("throwIpcError('UNSUPPORTED_CAPABILITY'");
  });

  it('keeps tasks created from these tasks on the same computer', () => {
    const start = source.indexOf('async function sendToSessionInternal(');
    const body = source.slice(start, source.indexOf('assertDesktopSendDispatched(sendResult', start));
    expect(body).toContain('if (meta.agentDeviceId && !meta.remoteHostId) inheritedAgentDeviceId = meta.agentDeviceId;');
    expect(body).toContain('...(inheritedAgentDeviceId ? { agentDeviceId: inheritedAgentDeviceId } : {}),');
    // 换模型时按那台的目录校验，而不是本机目录。
    expect(body).toContain('availableModels: deviceRouting?.remoteCodexModels ?? maker.getCapabilities(targetAgent).availableModels,');
    expect(body).toContain('providerRouting: deviceRouting ?? await getProviderRoutingContext(),');
  });

  it("lists the other computer's models for Orca leads whose agent runs there", () => {
    const start = source.indexOf('listAvailableModels: async ({ agent, callerSessionId, agentDeviceId: requestedAgentDeviceId }) => {');
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start, source.indexOf('const providerRouting = await getProviderRoutingContext();', start));
    // 不指定位置时列 Lead 所在位置(Lead 归在供应商组里时列组那一项所在电脑)；Lead 也可以指定别的电脑 / 分享，
    // 或 null(任务所在电脑)。
    expect(body).toContain('readLeadProviderGroupEntry(callerSessionId, null).providerGroupEntry');
    expect(body).toMatch(/const leadAgentDeviceId = leadGroupEntry\s+\? leadGroupEntry\.agentDeviceId\s+: callerSessionId \? await readSessionAgentDeviceId\(callerSessionId\) : null;/);
    expect(body).toMatch(/requestedAgentDeviceId === undefined\s+\? leadAgentDeviceId/);
    expect(body).toContain('deviceAvailableModels(views, a)');
    expect(body).toContain('return agentDeviceCatalogFailure(err);');
  });
});
