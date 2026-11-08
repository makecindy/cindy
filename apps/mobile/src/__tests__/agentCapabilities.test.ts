import { describe, expect, it } from 'vitest';
import {
  buildMobileModelSwitchConfirmation,
  buildSessionRuntimeOptions,
  normalizeMobileAgentCapabilities,
  reconcileRuntimeDraftWithCapabilities,
} from '@/session/agentCapabilities';
import type { RemoteSession } from '@/session/types';

function session(patch: Partial<RemoteSession> = {}): RemoteSession {
  return {
    id: 's1',
    userId: 'u1',
    title: 'Remote session',
    workingDir: '/repo/xdt-maker',
    workspaceKind: 'project',
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    permissionMode: 'ask',
    fastMode: false,
    status: 'active',
    agentKind: 'cc',
    pinnedAt: null,
    userSendAt: null,
    createdAt: '2026-06-16T10:00:00.000Z',
    updatedAt: '2026-06-16T10:00:00.000Z',
    _count: { messages: 0 },
    ...patch,
  };
}

const desktopCapabilitiesPayload = {
  availableModels: [
    {
      id: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet 4.6',
      description: 'Default remote Claude model',
      contextWindow: 200_000,
      efforts: ['low', 'medium', 'high', 'xhigh'],
      effortDisplayNames: { xhigh: 'Max' },
      defaultEffort: 'medium',
      supportsFastMode: true,
    },
    {
      id: 'claude-haiku-4-6',
      displayName: 'Claude Haiku 4.6',
      contextWindow: 200_000,
      efforts: [],
      defaultEffort: null,
      supportsFastMode: false,
    },
  ],
  hasFastMode: true,
  effortLevels: [
    { id: 'low', displayName: 'Low' },
    { id: 'medium', displayName: 'Medium' },
    { id: 'high', displayName: 'High' },
    { id: 'xhigh', displayName: 'Extra High' },
  ],
  permissionModes: [
    { id: 'ask', displayName: 'Ask' },
    { id: 'acceptEdits', displayName: 'Accept Edits' },
    { id: 'plan', displayName: 'Plan' },
  ],
};

describe('mobile agent capabilities', () => {
  it('normalizes desktop capability payloads for mobile runtime controls', () => {
    const capabilities = normalizeMobileAgentCapabilities(desktopCapabilitiesPayload);

    expect(capabilities?.availableModels.map((item) => item.id)).toEqual([
      'claude-sonnet-4-6',
      'claude-haiku-4-6',
    ]);
    // 已知档 id 在 normalize 单点换成中文词表名(被控端英文 displayName 被覆盖)。
    expect(capabilities?.effortLevels.map((item) => item.label)).toEqual([
      '低',
      '中',
      '高',
      '超高',
    ]);
    expect(capabilities?.permissionModes.map((item) => item.id)).toEqual([
      'ask',
      'acceptEdits',
      'plan',
    ]);
  });

  it('uses the current model efforts and model-specific labels', () => {
    const capabilities = normalizeMobileAgentCapabilities(desktopCapabilitiesPayload);
    const runtime = buildSessionRuntimeOptions(session(), capabilities);

    expect(runtime.modelOptions.map((item) => item.label)).toContain('Claude Sonnet 4.6');
    expect(runtime.currentModel?.id).toBe('claude-sonnet-4-6');
    // 模型级 effortDisplayNames 覆盖(xhigh → 'Max')仍最优先;其余走中文词表。
    expect(runtime.effortOptions.map((item) => [item.id, item.label])).toEqual([
      ['low', '低'],
      ['medium', '中'],
      ['high', '高'],
      ['xhigh', 'Max'],
    ]);
    expect(runtime.permissionOptions.map((item) => item.id)).toEqual([
      'ask',
      'acceptEdits',
      'plan',
    ]);
    expect(runtime.fastModeSupported).toBe(true);
  });

  it('disables effort and fast mode when the selected model does not support them', () => {
    const capabilities = normalizeMobileAgentCapabilities(desktopCapabilitiesPayload);
    const runtime = buildSessionRuntimeOptions(session({ model: 'claude-haiku-4-6' }), capabilities);

    expect(runtime.effortOptions).toEqual([]);
    expect(runtime.fastModeSupported).toBe(false);
  });

  it('keeps the legacy fallback options while capabilities are unavailable', () => {
    const runtime = buildSessionRuntimeOptions(session(), null);

    expect(runtime.capabilitiesLoaded).toBe(false);
    expect(runtime.modelOptions).toEqual([]);
    expect(runtime.effortOptions.map((item) => item.id)).toEqual(['low', 'medium', 'high']);
    expect(runtime.permissionOptions.map((item) => item.id)).toEqual([
      'default',
      'ask',
      'acceptEdits',
      'plan',
      'bypassPermissions',
    ]);
    expect(runtime.fastModeSupported).toBe(true);
  });

  it('reconciles new-session runtime drafts to the selected model capabilities', () => {
    const capabilities = normalizeMobileAgentCapabilities(desktopCapabilitiesPayload);

    expect(reconcileRuntimeDraftWithCapabilities({
      model: 'missing-model',
      providerId: 'removed-provider',
      effort: 'ultra',
      permissionMode: 'bypassPermissions',
      fastMode: true,
    }, capabilities)).toMatchObject({
      model: 'claude-sonnet-4-6',
      providerId: null,
      effort: 'medium',
      permissionMode: 'ask',
      fastMode: true,
    });

    expect(reconcileRuntimeDraftWithCapabilities({
      model: 'claude-haiku-4-6',
      effort: 'medium',
      permissionMode: 'plan',
      fastMode: true,
    }, capabilities)).toMatchObject({
      model: 'claude-haiku-4-6',
      effort: '',
      permissionMode: 'plan',
      fastMode: false,
    });
  });

  it('preserves only an explicitly selected provider model while its descriptor catches up', () => {
    const capabilities = normalizeMobileAgentCapabilities(desktopCapabilitiesPayload);
    const draft = {
      model: 'new-provider-model',
      providerId: 'new-provider',
      effort: 'high',
      permissionMode: 'bypassPermissions',
      fastMode: true,
    };

    expect(reconcileRuntimeDraftWithCapabilities(draft, capabilities, {
      preserveUnknownModel: true,
    })).toBe(draft);
  });

  it('requires confirmation only for history-incompatible model category switches', () => {
    expect(buildMobileModelSwitchConfirmation({
      currentModelId: 'claude-sonnet-4-6',
      targetModelId: 'gpt-5.5',
      messageCount: 0,
    })).toBeNull();

    expect(buildMobileModelSwitchConfirmation({
      currentModelId: 'claude-sonnet-4-6',
      targetModelId: 'claude-opus-4-7',
      messageCount: 12,
    })).toBeNull();

    expect(buildMobileModelSwitchConfirmation({
      currentModelId: 'gpt-5.5',
      targetModelId: 'codex/gpt-5.5',
      messageCount: 12,
    })).toBeNull();

    expect(buildMobileModelSwitchConfirmation({
      currentModelId: 'claude-sonnet-4-6',
      targetModelId: 'gpt-5.5',
      messageCount: 12,
    })).toMatchObject({
      fromCategory: 'anthropic',
      fromLabel: 'Anthropic',
      targetModelId: 'gpt-5.5',
      toCategory: 'gpt',
      toLabel: 'GPT',
    });
  });
});

// #8215: native Pi compaction is advertised by the host; older/malformed hosts fail closed.
it.each([[{ supported: true }, true], [{ supported: false }, false], [undefined, false], [{ supported: 'true' }, false]])('normalizes host manual compaction %o as %s', (manualCompact, expected) => {
  expect(normalizeMobileAgentCapabilities({ ...desktopCapabilitiesPayload, manualCompact })?.manualCompactSupported).toBe(expected);
});
