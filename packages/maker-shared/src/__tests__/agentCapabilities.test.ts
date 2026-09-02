import { describe, expect, it } from 'vitest';
import {
  buildMobileModelSwitchConfirmation,
  buildSessionRuntimeOptions,
  categorizeMobileModel,
  compactEnglishEffortLabel,
  normalizeMobileAgentCapabilities,
  reconcileRuntimeDraftWithCapabilities,
  shouldBlockLegacyRemoteModelWindowSwitch,
} from '../agentCapabilities';

const desktopCapabilitiesPayload = {
  availableModels: [
    {
      id: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet 4.6',
      description: 'Default remote Claude model',
      contextWindow: 200_000,
      efforts: ['low', 'medium', 'high', 'xhigh'],
      effortDisplayNames: { xhigh: 'Extra High' },
      defaultEffort: 'medium',
      supportsFastMode: true,
      newSessionDefault: ['claude-code', 'invalid-agent', 'claude-code', 'codex', 'pi'],
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

describe('agent capabilities shared model', () => {
  it('uses the same English compact effort labels on desktop and mobile', () => {
    expect(
      ['minimal', 'low', 'medium', 'high', 'xhigh', 'ultra', 'max'].map((effort) =>
        compactEnglishEffortLabel(effort),
      ),
    ).toEqual(['Minimal', 'Low', 'Medium', 'High', 'Extra', 'Ultra', 'Max']);
    expect(compactEnglishEffortLabel('extra-high')).toBe('Extra');
    expect(compactEnglishEffortLabel('adaptive-fast', 'Adaptive Fast')).toBe('Adaptive Fast');
    expect(compactEnglishEffortLabel('adaptive-safe', 'Adaptive Safe')).toBe('Adaptive Safe');
    expect(compactEnglishEffortLabel('adaptive-fast')).toBe('adaptive-fast');
    expect(compactEnglishEffortLabel('adaptive-safe')).toBe('adaptive-safe');
  });

  it('normalizes desktop capability payloads for runtime controls', () => {
    const capabilities = normalizeMobileAgentCapabilities(desktopCapabilitiesPayload);

    expect(capabilities?.availableModels.map((item) => item.id)).toEqual([
      'claude-sonnet-4-6',
      'claude-haiku-4-6',
    ]);
    expect(capabilities?.availableModels.map((item) => item.contextWindow)).toEqual([
      200_000,
      200_000,
    ]);
    // 已知档 id 在 normalize 单点换成中文词表名(被控端给的英文 displayName 被覆盖)。
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
    expect(capabilities?.supportsSessionAgentSwitch).toBe(false);
    expect(capabilities?.supportsModelWindowSwitchGuard).toBe(false);
    expect(capabilities?.availableModels[0].newSessionDefault).toEqual(['claude-code', 'codex', 'pi']);
    expect('newSessionDefault' in (capabilities?.availableModels[1] ?? {})).toBe(false);
    expect(normalizeMobileAgentCapabilities({
      ...desktopCapabilitiesPayload,
      supportsSessionAgentSwitch: true,
    })?.supportsSessionAgentSwitch).toBe(true);
    expect(normalizeMobileAgentCapabilities({
      ...desktopCapabilitiesPayload,
      supportsModelWindowSwitchGuard: true,
    })?.supportsModelWindowSwitchGuard).toBe(true);
  });

  describe('legacy host model-window guard', () => {
    const pressuredShrink = {
      hostGuardSupported: false,
      agentKind: 'codex',
      contextTokens: 180_000,
      currentContextWindow: 1_000_000,
      targetContextWindow: 200_000,
    };

    it('blocks non-Pi legacy shrinks at 90% while preserving same/expand, low pressure, and SSH semantics', () => {
      expect(shouldBlockLegacyRemoteModelWindowSwitch(pressuredShrink)).toBe(true);
      expect(shouldBlockLegacyRemoteModelWindowSwitch({
        ...pressuredShrink,
        contextTokens: 179_999,
      })).toBe(false);
      expect(shouldBlockLegacyRemoteModelWindowSwitch({
        ...pressuredShrink,
        targetContextWindow: 1_000_000,
      })).toBe(false);
      expect(shouldBlockLegacyRemoteModelWindowSwitch({
        ...pressuredShrink,
        targetContextWindow: 2_000_000,
      })).toBe(false);
      const pressuredSshShrink = { ...pressuredShrink, isSsh: true };
      expect(shouldBlockLegacyRemoteModelWindowSwitch(pressuredSshShrink)).toBe(true);
    });

    it('fails closed for every estimated legacy Pi route and defers guarded Pi to the host', () => {
      const legacyPiSwitch = { ...pressuredShrink, agentKind: 'pi' };
      const estimatedPiRoutes = {
        lowPressure: { ...legacyPiSwitch, contextTokens: 179_999 },
        exact90Percent: legacyPiSwitch,
        sameWindow: { ...legacyPiSwitch, targetContextWindow: 1_000_000 },
        expansion: { ...legacyPiSwitch, targetContextWindow: 2_000_000 },
        unknownUsage: { ...legacyPiSwitch, contextTokens: undefined },
        unknownCurrentWindow: { ...legacyPiSwitch, currentContextWindow: undefined },
        unknownTargetWindow: { ...legacyPiSwitch, targetContextWindow: undefined },
      };
      for (const route of Object.values(estimatedPiRoutes)) {
        expect(shouldBlockLegacyRemoteModelWindowSwitch(route)).toBe(true);
      }
      expect(shouldBlockLegacyRemoteModelWindowSwitch({
        ...legacyPiSwitch,
        hostGuardSupported: true,
      })).toBe(false);
      expect(shouldBlockLegacyRemoteModelWindowSwitch({
        ...legacyPiSwitch,
        hostGuardSupported: true,
        contextTokens: undefined,
        targetContextWindow: undefined,
      })).toBe(false);
    });

    it('fails closed when legacy-host window or usage facts are unknown', () => {
      expect(shouldBlockLegacyRemoteModelWindowSwitch({
        ...pressuredShrink,
        contextTokens: undefined,
      })).toBe(true);
      expect(shouldBlockLegacyRemoteModelWindowSwitch({
        ...pressuredShrink,
        currentContextWindow: undefined,
      })).toBe(true);
      expect(shouldBlockLegacyRemoteModelWindowSwitch({
        ...pressuredShrink,
        targetContextWindow: undefined,
      })).toBe(true);
      expect(shouldBlockLegacyRemoteModelWindowSwitch({
        ...pressuredShrink,
        contextTokens: undefined,
        targetContextWindow: 1_000_000,
      })).toBe(false);
    });
  });

  it('uses the current model efforts and model-specific labels', () => {
    const capabilities = normalizeMobileAgentCapabilities(desktopCapabilitiesPayload);
    const runtime = buildSessionRuntimeOptions({ model: 'claude-sonnet-4-6' }, capabilities);

    expect(runtime.modelOptions.map((item) => item.label)).toContain('Claude Sonnet 4.6');
    expect(runtime.currentModel?.id).toBe('claude-sonnet-4-6');
    // 模型级 effortDisplayNames 覆盖(xhigh → 'Extra High')仍最优先;其余走中文词表。
    expect(runtime.effortOptions.map((item) => [item.id, item.label])).toEqual([
      ['low', '低'],
      ['medium', '中'],
      ['high', '高'],
      ['xhigh', 'Extra High'],
    ]);
    expect(runtime.permissionOptions.map((item) => item.id)).toEqual([
      'ask',
      'acceptEdits',
      'plan',
    ]);
    expect(runtime.fastModeSupported).toBe(true);
  });

  it('surfaces Codex max/ultra efforts with localized labels (issue #352 GPT-5.6 Sol via remote control)', () => {
    // 模拟被控端经 device-link 透传的 capabilities:GPT-5.6 Sol 声明支持到 ultra。
    const capabilities = normalizeMobileAgentCapabilities({
      ...desktopCapabilitiesPayload,
      availableModels: [
        {
          id: 'codex/gpt-5.6-sol',
          displayName: 'GPT-5.6-Sol',
          contextWindow: 372_000,
          efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
          defaultEffort: 'high',
          supportsFastMode: true,
        },
      ],
      effortLevels: [
        { id: 'low', displayName: 'Low' },
        { id: 'medium', displayName: 'Medium' },
        { id: 'high', displayName: 'High' },
        { id: 'xhigh', displayName: 'Extra' },
        { id: 'max', displayName: 'Max' },
        { id: 'ultra', displayName: 'Ultra' },
      ],
    });
    const runtime = buildSessionRuntimeOptions({ model: 'codex/gpt-5.6-sol' }, capabilities);
    expect(runtime.effortOptions.map((item) => [item.id, item.label])).toEqual([
      ['low', '低'],
      ['medium', '中'],
      ['high', '高'],
      ['xhigh', '超高'],
      ['max', '最高'],
      ['ultra', '极致'],
    ]);
    // 反向:该模型声明支持 ultra,显式选中不被降级(不做全局硬塞也不错误剔除)。
    expect(reconcileRuntimeDraftWithCapabilities({
      model: 'codex/gpt-5.6-sol',
      effort: 'ultra',
      permissionMode: 'ask',
      fastMode: false,
    }, capabilities).effort).toBe('ultra');
  });

  it('disables effort and fast mode when the selected model does not support them', () => {
    const capabilities = normalizeMobileAgentCapabilities(desktopCapabilitiesPayload);
    const runtime = buildSessionRuntimeOptions({ model: 'claude-haiku-4-6' }, capabilities);

    expect(runtime.effortOptions).toEqual([]);
    expect(runtime.fastModeSupported).toBe(false);
  });

  it('keeps the legacy fallback options while capabilities are unavailable', () => {
    const runtime = buildSessionRuntimeOptions({ model: 'claude-sonnet-4-6' }, null);

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
      effort: 'ultra',
      permissionMode: 'bypassPermissions',
      fastMode: true,
    }, capabilities)).toMatchObject({
      model: 'missing-model',
      effort: 'ultra',
      permissionMode: 'bypassPermissions',
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

  it('categorizeMobileModel:折扣路由判在 gpt 之前,命名空间形态与裸 id 同等对待', () => {
    // codex/gpt-5.5 的尾段是 gpt-5.5;判定顺序反了会把「GPT 折扣」读成「GPT」,
    // 而这个分类名会原样出现在切换确认框的标题与说明里。
    expect(categorizeMobileModel('codex/gpt-5.5')).toBe('gpt-budget');
    expect(categorizeMobileModel('codex/gpt-5.6-sol')).toBe('gpt-budget');
    expect(categorizeMobileModel('gpt-5.5')).toBe('gpt');
    // 目录下发的 id 带命名空间,尾段也要认,否则整批模型掉进兜底分类。
    expect(categorizeMobileModel('anthropic/claude-opus-5')).toBe('anthropic');
    expect(categorizeMobileModel('openai/gpt-5.5')).toBe('gpt');
    expect(categorizeMobileModel('google/gemini-3.5-flash')).toBe('google');
    // 认不出厂商就落中性组,不猜产地(手机端这条链拿不到目录 group)。
    expect(categorizeMobileModel('qwen/qwen3.7-max')).toBe('ungrouped');
    expect(categorizeMobileModel('mistral-large-latest')).toBe('ungrouped');
  });

  it('切换确认框把折扣路由读成「GPT 折扣」,不读成「GPT」', () => {
    expect(buildMobileModelSwitchConfirmation({
      currentModelId: 'claude-sonnet-4-6',
      targetModelId: 'codex/gpt-5.5',
      messageCount: 12,
    })).toMatchObject({
      fromCategory: 'anthropic',
      toCategory: 'gpt-budget',
      toLabel: 'GPT 折扣',
    });
  });

  it('切到未知厂商模型时显示「未分组」,不再显示含厂商断言的旧兜底名', () => {
    expect(buildMobileModelSwitchConfirmation({
      currentModelId: 'claude-sonnet-4-6',
      targetModelId: 'moonshot/kimi-k3',
      messageCount: 12,
    })).toMatchObject({
      fromCategory: 'anthropic',
      toCategory: 'ungrouped',
      toLabel: '未分组',
    });
  });
});
