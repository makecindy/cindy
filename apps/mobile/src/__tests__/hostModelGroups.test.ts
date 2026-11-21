/**
 * 手机在被控电脑上用那台的模型组(Desktop docs/product-rules/model-groups.md §6.3)。
 *
 * 测试价值
 * - 生产入口与可观察结果：transport 的 listModelGroups / resolveModelGroup(经 device-link invoke)、
 *   parseHostModelGroupResult、applyHostModelGroupRoute + buildRemoteCreateSessionOptions 发出的创建参数、
 *   applyHostModelGroupResult 请那台做的记录与说明。
 * - 规则依据：model-groups.md §6.3(由那台电脑选、选出的模型只用于这次新建、那台是旧版本时不显示)；
 *   协议记录 docs/dev-rules/protocol-compatibility/model-groups-remote-pickers.md。
 * - 现有覆盖缺口：手机此前只在伙伴设置里认识模型组，新任务与进行中任务没有这条路径。
 * - 最小失败输入：旧电脑回 CHANNEL_NOT_ALLOWED 时报错而不是不显示；那台送来坏结果被当成选中；
 *   选出的来源没写进创建参数，或沿用了草稿的 Fast / 另一台电脑的位置；沿用原模型时仍去记绑定。
 * - tier：unit(纯函数与注入 invoke 的 transport，无原生依赖)。
 */
import { describe, expect, it, vi } from 'vitest';

import { createMobileMakerTransport, type RemoteInvoke } from '@/device-link/mobileMakerTransport';
import {
  applyHostModelGroupResult,
  applyHostModelGroupRoute,
  parseHostModelGroupResult,
} from '@/session/hostModelGroups';
import { buildRemoteCreateSessionOptions, type NewSessionDraft } from '@/session/newSession';

const draft: NewSessionDraft = {
  agentKind: 'claude-code', workspaceKind: 'project', workingDir: '/repo', model: 'claude-fable-5',
  providerId: 'xd', effort: 'high', permissionMode: 'default', fastMode: true, firstMessage: 'hi',
  agentDeviceId: 'mac-mini',
};

const routed = {
  outcome: 'routed', groupName: 'Daily', decisionId: 'd1', modelName: 'GPT', sourceName: 'Work',
  route: { agentKind: 'codex', providerId: 'openai-work', model: 'gpt-6', effort: 'medium' },
  why: 'expiring', quota: { usedPercent: 40, resetAtMs: 1_000 }, trace: [{ state: 'picked', limitedUntilMs: null }],
};

describe('the host computer\'s model groups over device-link', () => {
  it('treats an older computer without the channel as having no model groups', async () => {
    const invoke = vi.fn(async () => {
      throw Object.assign(new Error('[CHANNEL_NOT_ALLOWED] model-groups:get'), { code: 'CHANNEL_NOT_ALLOWED' });
    }) as unknown as RemoteInvoke;
    await expect(createMobileMakerTransport({ deviceId: 'old-desk', invoke }).listModelGroups()).resolves.toBeNull();
  });

  it('asks the host to pick and builds the new task from its pick, without Fast or the old location', async () => {
    const invoke = vi.fn(async () => routed) as unknown as RemoteInvoke;
    const maker = createMobileMakerTransport({ deviceId: 'desk', invoke });
    const result = parseHostModelGroupResult(await maker.resolveModelGroup({ selection: { type: 'route', id: 'daily' }, context: { hasImages: true } }));
    expect(invoke).toHaveBeenCalledWith('desk', 'model-groups:resolve', [{ selection: { type: 'route', id: 'daily' }, context: { hasImages: true } }]);
    const opts = buildRemoteCreateSessionOptions(applyHostModelGroupRoute(draft, result));
    expect(opts).toMatchObject({ agentKind: 'codex', providerId: 'openai-work', model: 'gpt-6', effort: 'medium', fastMode: false });
    expect(opts).not.toHaveProperty('agentDeviceId');
  });

  it.each([
    { name: 'unknown outcome', raw: { outcome: 'picked' } },
    { name: 'routed without a usable route', raw: { ...routed, route: { agentKind: 'acp', providerId: 'x', model: 'y' } } },
    { name: 'not an object', raw: 'routed' },
  ])('rejects a malformed host answer: $name', ({ raw }) => {
    expect(parseHostModelGroupResult(raw)).toBeNull();
  });

  it('keeps the draft when the host has no usable source, and only commits the decision', () => {
    const unavailable = parseHostModelGroupResult({ outcome: 'unavailable', groupName: 'Daily', decisionId: 'd2', trace: [] });
    expect(applyHostModelGroupRoute(draft, unavailable)).toBe(draft);
    const maker = {
      commitModelGroupDecision: vi.fn(async () => undefined),
      bindModelGroupSession: vi.fn(async () => undefined),
      writeModelGroupRouteNote: vi.fn(async () => undefined),
    };
    applyHostModelGroupResult(maker, 's1', 'daily', unavailable, { pluginName: 'Daily', outcome: 'kept' });
    expect(maker.commitModelGroupDecision).toHaveBeenCalledWith('d2');
    expect(maker.bindModelGroupSession).not.toHaveBeenCalled();
    expect(maker.writeModelGroupRouteNote).toHaveBeenCalledWith({ sessionId: 's1', note: { pluginName: 'Daily', outcome: 'kept' } });
  });

  it('records which source the task uses when the host picked one', () => {
    const maker = {
      commitModelGroupDecision: vi.fn(async () => undefined),
      bindModelGroupSession: vi.fn(async () => undefined),
      writeModelGroupRouteNote: vi.fn(async () => undefined),
    };
    applyHostModelGroupResult(maker, 's1', 'daily', parseHostModelGroupResult(routed), null);
    expect(maker.bindModelGroupSession).toHaveBeenCalledWith({
      sessionId: 's1', selection: { type: 'route', id: 'daily' },
      route: { agentKind: 'codex', providerId: 'openai-work', model: 'gpt-6' },
    });
    expect(maker.writeModelGroupRouteNote).not.toHaveBeenCalled();
  });
});
