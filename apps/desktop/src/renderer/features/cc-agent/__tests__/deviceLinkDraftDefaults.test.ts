import { describe, expect, it } from 'vitest';

import { resolveDeviceLinkDraftDefaults } from '../deviceLinkDraftDefaults';
import type { AgentCapabilities } from '@/hooks/useAgentCapabilities';

// 最小被控端 capabilities:两模型(Opus 支持 fast + 多 effort 档;Haiku 无 effort/fast)。
function caps(overrides: Partial<AgentCapabilities> = {}): AgentCapabilities {
  return {
    availableModels: [
      {
        id: 'claude-opus-4-8',
        displayName: 'Opus 4.8',
        contextWindow: 1_000_000,
        efforts: ['high', 'xhigh'],
        defaultEffort: 'high',
        supportsFastMode: true,
      },
      {
        id: 'claude-haiku-4-5',
        displayName: 'Haiku 4.5',
        contextWindow: 200_000,
        efforts: [],
        defaultEffort: null,
        supportsFastMode: false,
      },
    ],
    hasFastMode: true,
    effortLevels: [
      { id: 'high', displayName: 'High' },
      { id: 'xhigh', displayName: 'X-High' },
    ],
    permissionModes: [
      { id: 'acceptEdits', displayName: 'Accept edits' },
      { id: 'bypassPermissions', displayName: 'Bypass' },
    ],
    ...overrides,
  };
}

describe('resolveDeviceLinkDraftDefaults', () => {
  it('空 capabilities + agent context reads bundled defaults; missing agent retains empty fallback', () => {
    expect(resolveDeviceLinkDraftDefaults(caps({ availableModels: [] }), null, undefined, 'codex').model)
      .toBe('gpt-5.5');
    expect(resolveDeviceLinkDraftDefaults(caps({ availableModels: [] }), null).model).toBe('');
  });

  it('被控端草稿值在清单内 → 原样镜像(model/effort/fast/permission/source)', () => {
    const sel = resolveDeviceLinkDraftDefaults(caps(), {
      model: 'claude-opus-4-8',
      effort: 'xhigh',
      fastMode: true,
      permissionMode: 'bypassPermissions',
      providerId: 'anthropic',
    });
    expect(sel).toEqual({
      model: 'claude-opus-4-8',
      effort: 'xhigh',
      fastMode: true,
      permissionMode: 'bypassPermissions',
      providerId: 'anthropic',
    });
  });

  it('remoteDraft=null(旧版被控端/拉取失败)→ 回落被控端 capabilities 默认,绝不取本地', () => {
    const sel = resolveDeviceLinkDraftDefaults(caps(), null);
    expect(sel.model).toBe('claude-opus-4-8'); // availableModels[0]
    expect(sel.effort).toBe('high'); // 该模型 defaultEffort
    expect(sel.fastMode).toBe(false); // 草稿没开 → 关
    expect(sel.permissionMode).toBeUndefined(); // 无草稿权限 → 由 ChatInput 回落
    expect(sel.providerId).toBeNull();
  });

  it('被控端草稿 model 不在清单 → reconcile 到 availableModels[0] + 其默认 effort', () => {
    const sel = resolveDeviceLinkDraftDefaults(caps(), {
      model: 'gpt-5.4', // 被控端 claude agent 不 offer
      effort: 'low',
      fastMode: true,
    });
    expect(sel.model).toBe('claude-opus-4-8');
    expect(sel.effort).toBe('high'); // 'low' 不被 Opus 支持 → defaultEffort
  });

  it('effort 不被目标模型支持 → 落该模型 defaultEffort', () => {
    const sel = resolveDeviceLinkDraftDefaults(caps(), {
      model: 'claude-opus-4-8',
      effort: 'low', // Opus 只支持 high/xhigh
    });
    expect(sel.effort).toBe('high');
  });

  it('模型不支持 fast(或被控端 agent 无 fast 能力)→ fastMode 强制 false', () => {
    // 选中无 fast 的 Haiku
    const a = resolveDeviceLinkDraftDefaults(caps(), {
      model: 'claude-haiku-4-5',
      fastMode: true,
    });
    expect(a.fastMode).toBe(false);
    // agent 整体无 fast 能力
    const b = resolveDeviceLinkDraftDefaults(caps({ hasFastMode: false }), {
      model: 'claude-opus-4-8',
      fastMode: true,
    });
    expect(b.fastMode).toBe(false);
  });

  it('被控端不支持的 permission 档 → undefined(交 ChatInput 回落)', () => {
    const sel = resolveDeviceLinkDraftDefaults(caps(), {
      model: 'claude-opus-4-8',
      permissionMode: 'plan', // 不在被控端 permissionModes
    });
    expect(sel.permissionMode).toBeUndefined();
  });

  // ─── targetModel:切到列表里其它模型时,还原被控端 per-model 记忆 ───────────────
  it('切到非当前选中模型 → 用被控端 per-model 记忆,而非沿用上一个模型', () => {
    const sel = resolveDeviceLinkDraftDefaults(
      caps(),
      {
        model: 'claude-haiku-4-5', // 被控端当前选中 = Haiku(无 effort/fast)
        effort: undefined,
        fastMode: false,
        effortByModel: { 'claude-opus-4-8': 'xhigh' }, // 被控端为 Opus 记的档
        fastModeByModel: { 'claude-opus-4-8': true },
      },
      'claude-opus-4-8', // 用户在草稿里切到 Opus
    );
    expect(sel.model).toBe('claude-opus-4-8');
    expect(sel.effort).toBe('xhigh'); // 来自 effortByModel[Opus],非当前选中 Haiku 的值
    expect(sel.fastMode).toBe(true); // 来自 fastModeByModel[Opus]
  });

  it('切到的模型被控端无 per-model 记忆 → 回落该模型 capabilities 默认', () => {
    const sel = resolveDeviceLinkDraftDefaults(
      caps(),
      { model: 'claude-haiku-4-5', effortByModel: {}, fastModeByModel: {} },
      'claude-opus-4-8',
    );
    expect(sel.effort).toBe('high'); // Opus defaultEffort
    expect(sel.fastMode).toBe(false);
  });

  it('切回被控端当前选中模型 → 用草稿激活值(authoritative),不被 per-model 记忆覆盖', () => {
    const sel = resolveDeviceLinkDraftDefaults(
      caps(),
      {
        model: 'claude-opus-4-8',
        effort: 'xhigh', // 激活档
        fastMode: true,
        effortByModel: { 'claude-opus-4-8': 'high' }, // 记忆里是 high(与激活档不同)
        fastModeByModel: { 'claude-opus-4-8': false },
      },
      'claude-opus-4-8', // 切回当前模型
    );
    expect(sel.effort).toBe('xhigh'); // 用激活档,不是记忆的 high
    expect(sel.fastMode).toBe(true);
  });

  it('首页当前显示模型也采用被控端全局模型预设', () => {
    const sel = resolveDeviceLinkDraftDefaults(
      caps(),
      {
        model: 'claude-opus-4-8',
        effort: 'high',
        fastMode: false,
        providerModelMemory: {
          'claude-code:*': {
            effortByModel: { 'claude-opus-4-8': 'xhigh' },
            fastByModel: { 'claude-opus-4-8': true },
          },
        },
      },
      undefined,
      'claude-code',
    );
    expect(sel.effort).toBe('xhigh');
    expect(sel.fastMode).toBe(true);
  });
});
