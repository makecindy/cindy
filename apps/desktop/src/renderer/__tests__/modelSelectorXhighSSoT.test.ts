/**
 * modelSelectorXhighSSoT.test.ts
 * ---------------------------------------------------------------------------
 * Regression test for: model-selector-xhigh-ui-stale (2026-04-21)
 *                    + draft-effort-server-coupling (2026-07-17)
 *
 * 一、model-selector-xhigh-ui-stale(2026-04-21):
 * 现象：在 Opus 4.7 上把 thinking 档位切到 xhigh，模型选择器 UI 没有立刻反映新选择，
 *       需切换 session 后再切回来才正确显示。
 * 根因：ChatInput.tsx 内部维护了 local override state，与 props 派生值形成"两条独立的
 *       状态轨道"。
 * 修复：删除 local state，改为直接从 props 派生 active 值；handler 持久化成功后调
 *       onXxxDidChange 上抛，由父组件 merge 精确值让 props 重新流下来——单一可信源。
 *
 * 二、draft-effort-server-coupling(2026-07-17):
 * 现象：登录令牌失效(401)后,草稿(未创建任务)里推理强度点了没反应。
 * 根因：草稿分支 `await updatePreferences(服务端 PATCH)` 成功后才调 onEffortDidChange,
 *       服务端失败被 catch 静默吞掉 → UI 永不刷新。
 * 修复：默认模型/档位偏好全量本地化(newMakerDraft.lastByVendor 按 agent 分槽 +
 *       providerModelMemory 按 (agent, 模型) 全局记忆),handler 不再有任何服务端
 *       偏好写入;草稿分支直接同步上抛 onXxxDidChange。
 *
 * 本测试不依赖 React/jsdom，只验证契约的核心不变量：
 *   1. active 派生函数：activeXxx = initialXxx ?? 本地草稿 lastByVendor 兜底
 *   2. handler 契约：会话态本地 DB 写成功后上抛 onXxxDidChange，失败时不上抛;
 *      草稿态**同步**上抛,全程无任何服务端调用(离线 / 令牌失效不影响)。
 */

import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// 类型镜像（避免拉真模块的 React/Tiptap 副作用）
// ---------------------------------------------------------------------------
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
type PermissionMode = 'ask' | 'auto' | 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

/** 本地草稿 per-vendor 偏好(newMakerDraft.lastByVendor 单槽的最小镜像)。 */
interface DraftVendorPrefs {
  model: string;
  effort: Effort;
  permissionMode: PermissionMode;
}

interface ChatInputDerivedProps {
  initialModel?: string;
  initialEffort?: Effort;
  initialPermissionMode?: PermissionMode;
  /** getDraft().lastByVendor[vendor] —— localStorage,sanitize 恒有种子值。 */
  localVendorDefaults: DraftVendorPrefs;
}

interface ChatInputDerived {
  activeModel: string;
  activeEffort: Effort;
  activePermissionMode: PermissionMode;
}

/**
 * 镜像 ChatInput.tsx 的派生逻辑（SSoT 形态）。
 * 契约：active 值永远来自 props + 本地草稿兜底，**不掺 local state、不读服务端**。
 */
function deriveActive(p: ChatInputDerivedProps): ChatInputDerived {
  return {
    activeModel: p.initialModel ?? p.localVendorDefaults.model,
    activeEffort: p.initialEffort ?? p.localVendorDefaults.effort,
    activePermissionMode: p.initialPermissionMode ?? p.localVendorDefaults.permissionMode,
  };
}

// ---------------------------------------------------------------------------
// handler 契约镜像（ChatInput.tsx 的三个 handleXxxChange,2026-07-17 本地化后形态)
// ---------------------------------------------------------------------------
interface HandlerDeps {
  sessionId?: string;
  /** sessionService.update —— 本地 SQLite(经 IPC),不是服务端。 */
  sessionUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>;
  ipcSetEffort?: (id: string, eff: Effort) => Promise<void>;
  ipcSetModel?: (id: string, model: string) => Promise<void>;
  ipcUpdatePerm?: (id: string, mode: PermissionMode) => Promise<void>;
  currentPermissionMode?: PermissionMode;
  onModelDidChange?: (id: string) => void;
  onEffortDidChange?: (eff: Effort, sourceSessionId?: string) => void;
  onPermissionModeDidChange?: (mode: PermissionMode) => void;
}

async function handleEffortChange(deps: HandlerDeps, newEffort: Effort): Promise<void> {
  try {
    if (deps.sessionId) {
      await deps.sessionUpdate(deps.sessionId, { effort: newEffort });
      await deps.ipcSetEffort?.(deps.sessionId, newEffort).catch(() => {});
      deps.onEffortDidChange?.(newEffort, deps.sessionId);
      return;
    }

    // 草稿态:全本地,同步上抛(无任何 await 的服务端 / 本地 IO 前置)。
    deps.onEffortDidChange?.(newEffort);
  } catch (err) {
    // swallow — UI stays unchanged because parent never receives signal
    void err;
  }
}

async function handlePermissionModeChange(
  deps: HandlerDeps,
  newMode: PermissionMode,
): Promise<void> {
  try {
    if (deps.sessionId) {
      await deps.ipcUpdatePerm?.(deps.sessionId, newMode);
      try {
        await deps.sessionUpdate(deps.sessionId, { permissionMode: newMode });
      } catch (error) {
        await deps.ipcUpdatePerm?.(deps.sessionId, deps.currentPermissionMode ?? 'ask');
        throw error;
      }
    }
    deps.onPermissionModeDidChange?.(newMode);
  } catch (err) {
    void err;
  }
}

async function handleModelChange(
  deps: HandlerDeps,
  newModelId: string,
  computeNextEffort: () => Effort,
): Promise<void> {
  const newEffort = computeNextEffort();
  try {
    if (deps.sessionId) {
      await deps.sessionUpdate(deps.sessionId, { model: newModelId, effort: newEffort });
      deps.ipcSetModel?.(deps.sessionId, newModelId).catch(() => {});
      deps.onModelDidChange?.(newModelId);
      deps.onEffortDidChange?.(newEffort, deps.sessionId);
      return;
    }

    // 草稿态:全本地,同步上抛。
    deps.onModelDidChange?.(newModelId);
    deps.onEffortDidChange?.(newEffort);
  } catch (err) {
    void err;
  }
}

// ===========================================================================
// 1. SSoT 派生契约
// ===========================================================================

describe('SSoT derive: activeXxx 永远从 props + 本地草稿兜底派生', () => {
  const baseline: DraftVendorPrefs = {
    model: 'claude-opus-4-7',
    effort: 'high',
    permissionMode: 'auto',
  };

  it('initialEffort 提供时取 initialEffort（即会话持久化值）', () => {
    const derived = deriveActive({
      initialModel: 'claude-opus-4-7',
      initialEffort: 'xhigh',
      initialPermissionMode: 'acceptEdits',
      localVendorDefaults: baseline,
    });
    expect(derived.activeEffort).toBe('xhigh');
    expect(derived.activeModel).toBe('claude-opus-4-7');
    expect(derived.activePermissionMode).toBe('acceptEdits');
  });

  it('initialEffort 缺失时回退到本地草稿 lastByVendor（不再依赖服务端偏好）', () => {
    const derived = deriveActive({ localVendorDefaults: baseline });
    expect(derived.activeEffort).toBe('high');
    expect(derived.activeModel).toBe('claude-opus-4-7');
    expect(derived.activePermissionMode).toBe('auto');
  });

  it('initialPermissionMode 缺失时回退当前 agent 的本地草稿默认', () => {
    const derived = deriveActive({
      initialModel: 'claude-sonnet-4-6',
      localVendorDefaults: baseline,
    });
    expect(derived.activePermissionMode).toBe('auto');
  });

  it('修复场景核心：initialEffort=xhigh 时立刻反映 xhigh（不留任何 local override 路径）', () => {
    const derived = deriveActive({
      initialEffort: 'xhigh',
      localVendorDefaults: baseline,
    });
    expect(derived.activeEffort).toBe('xhigh');
  });

  it('跨 session：父组件喂不同 initialEffort 时立刻切换显示（不卡在前一个 session 的值）', () => {
    const sessA = deriveActive({ initialEffort: 'xhigh', localVendorDefaults: baseline });
    const sessB = deriveActive({ initialEffort: 'medium', localVendorDefaults: baseline });
    expect(sessA.activeEffort).toBe('xhigh');
    expect(sessB.activeEffort).toBe('medium');
    const sessAAgain = deriveActive({ initialEffort: 'xhigh', localVendorDefaults: baseline });
    expect(sessAAgain.activeEffort).toBe('xhigh');
  });
});

// ===========================================================================
// 2. handler 契约：本地持久化成功 → 上抛回调；失败 → 静默不抛;全程无服务端调用
// ===========================================================================

describe('handleEffortChange: 上抛 onEffortDidChange 给父组件同步 SSoT', () => {
  it('会话态 high → xhigh：本地 sessionUpdate 通过 → 上抛精确的 xhigh', async () => {
    const sessionUpdate = vi.fn().mockResolvedValue(undefined);
    const ipcSetEffort = vi.fn().mockResolvedValue(undefined);
    const onEffortDidChange = vi.fn();
    await handleEffortChange(
      { sessionId: 'sess-1', sessionUpdate, ipcSetEffort, onEffortDidChange },
      'xhigh',
    );
    expect(sessionUpdate).toHaveBeenCalledWith('sess-1', { effort: 'xhigh' });
    expect(onEffortDidChange).toHaveBeenCalledWith('xhigh', 'sess-1');
    expect(onEffortDidChange).toHaveBeenCalledTimes(1);
  });

  it('会话态失败路径：sessionUpdate 抛错 → onEffortDidChange 不被调用（UI 不会被错误信号刷新）', async () => {
    const onEffortDidChange = vi.fn();
    await handleEffortChange(
      {
        sessionId: 'sess-1',
        sessionUpdate: vi.fn().mockRejectedValue(new Error('db boom')),
        onEffortDidChange,
      },
      'xhigh',
    );
    expect(onEffortDidChange).not.toHaveBeenCalled();
  });

  it('草稿态(无 sessionId)：同步上抛 onEffortDidChange,不碰会话 DB', async () => {
    const sessionUpdate = vi.fn();
    const onEffortDidChange = vi.fn();
    await handleEffortChange({ sessionUpdate, onEffortDidChange }, 'xhigh');
    expect(sessionUpdate).not.toHaveBeenCalled();
    expect(onEffortDidChange).toHaveBeenCalledWith('xhigh');
  });

  it('回归守护(2026-07-17)：草稿态上抛不 await 任何异步前置——服务端/网络不可用不能再冻结档位选择', () => {
    // handler 返回的 promise 尚未 settle 时回调就必须已经发生:
    // 若未来有人把"先写远端再上抛"的模式加回草稿分支,本断言立刻红。
    const onEffortDidChange = vi.fn();
    void handleEffortChange({ sessionUpdate: vi.fn(), onEffortDidChange }, 'max');
    expect(onEffortDidChange).toHaveBeenCalledWith('max');
  });
});

describe('handlePermissionModeChange: 上抛 onPermissionModeDidChange', () => {
  it('成功路径：上抛新 mode', async () => {
    const sessionUpdate = vi.fn().mockResolvedValue(undefined);
    const ipcUpdatePerm = vi.fn().mockResolvedValue(undefined);
    const onPermissionModeDidChange = vi.fn();
    await handlePermissionModeChange(
      { sessionId: 'sess-1', sessionUpdate, ipcUpdatePerm, onPermissionModeDidChange },
      'bypassPermissions',
    );
    expect(sessionUpdate).toHaveBeenCalledWith('sess-1', { permissionMode: 'bypassPermissions' });
    expect(ipcUpdatePerm).toHaveBeenCalledWith('sess-1', 'bypassPermissions');
    expect(ipcUpdatePerm.mock.invocationCallOrder[0]).toBeLessThan(
      sessionUpdate.mock.invocationCallOrder[0],
    );
    expect(onPermissionModeDidChange).toHaveBeenCalledWith('bypassPermissions');
  });

  it('失败路径：sessionUpdate 抛错 → onPermissionModeDidChange 不调用', async () => {
    const onPermissionModeDidChange = vi.fn();
    const ipcUpdatePerm = vi.fn().mockResolvedValue(undefined);
    await handlePermissionModeChange(
      {
        sessionId: 'sess-1',
        sessionUpdate: vi.fn().mockRejectedValue(new Error('boom')),
        ipcUpdatePerm,
        currentPermissionMode: 'ask',
        onPermissionModeDidChange,
      },
      'bypassPermissions',
    );
    expect(ipcUpdatePerm.mock.calls).toEqual([
      ['sess-1', 'bypassPermissions'],
      ['sess-1', 'ask'],
    ]);
    expect(onPermissionModeDidChange).not.toHaveBeenCalled();
  });

  it('permissionMode 都能上抛（确认对称化覆盖完整）', async () => {
    const modes: PermissionMode[] = [
      'ask',
      'auto',
      'default',
      'acceptEdits',
      'bypassPermissions',
      'plan',
    ];
    for (const mode of modes) {
      const onPermissionModeDidChange = vi.fn();
      await handlePermissionModeChange(
        {
          sessionId: 'sess-x',
          sessionUpdate: vi.fn().mockResolvedValue(undefined),
          ipcUpdatePerm: vi.fn().mockResolvedValue(undefined),
          onPermissionModeDidChange,
        },
        mode,
      );
      expect(onPermissionModeDidChange).toHaveBeenCalledWith(mode);
    }
  });
});

describe('handleModelChange: 同时上抛 onModelDidChange + onEffortDidChange', () => {
  it('跨模型回归：Opus → Sonnet effort 自动降级，两个 callback 都触发', async () => {
    const onModelDidChange = vi.fn();
    const onEffortDidChange = vi.fn();
    await handleModelChange(
      {
        sessionId: 'sess-1',
        sessionUpdate: vi.fn().mockResolvedValue(undefined),
        ipcSetModel: vi.fn().mockResolvedValue(undefined),
        onModelDidChange,
        onEffortDidChange,
      },
      'claude-sonnet-4-6',
      () => 'high',
    );
    expect(onModelDidChange).toHaveBeenCalledWith('claude-sonnet-4-6');
    expect(onEffortDidChange).toHaveBeenCalledWith('high', 'sess-1');
  });

  it('Haiku 无 effort 段：computeNextEffort 返回 low，依然走对称化上抛', async () => {
    const onModelDidChange = vi.fn();
    const onEffortDidChange = vi.fn();
    await handleModelChange(
      {
        sessionId: 'sess-1',
        sessionUpdate: vi.fn().mockResolvedValue(undefined),
        onModelDidChange,
        onEffortDidChange,
      },
      'claude-haiku-4-5',
      () => 'low',
    );
    expect(onModelDidChange).toHaveBeenCalledWith('claude-haiku-4-5');
    expect(onEffortDidChange).toHaveBeenCalledWith('low', 'sess-1');
  });

  it('失败路径：sessionUpdate 抛错 → 两个 callback 都不调（UI 保持旧状态）', async () => {
    const onModelDidChange = vi.fn();
    const onEffortDidChange = vi.fn();
    await handleModelChange(
      {
        sessionId: 'sess-1',
        sessionUpdate: vi.fn().mockRejectedValue(new Error('db boom')),
        onModelDidChange,
        onEffortDidChange,
      },
      'claude-opus-4-7',
      () => 'xhigh',
    );
    expect(onModelDidChange).not.toHaveBeenCalled();
    expect(onEffortDidChange).not.toHaveBeenCalled();
  });

  it('草稿态(无 sessionId)：同步上抛两个 callback,不碰会话 DB', async () => {
    const sessionUpdate = vi.fn();
    const onModelDidChange = vi.fn();
    const onEffortDidChange = vi.fn();
    await handleModelChange(
      { sessionUpdate, onModelDidChange, onEffortDidChange },
      'claude-opus-4-8',
      () => 'high',
    );
    expect(sessionUpdate).not.toHaveBeenCalled();
    expect(onModelDidChange).toHaveBeenCalledWith('claude-opus-4-8');
    expect(onEffortDidChange).toHaveBeenCalledWith('high');
  });
});

// ===========================================================================
// 3. 端到端的 SSoT 闭环：handler → callback → 父组件 merge → props 流回
// ===========================================================================

describe('SSoT 闭环：模拟父组件 merge 后，下次 derive 拿到新值', () => {
  it('会话态:Fable 5 + high → 点 xhigh：父收到精确值后 session.effort 立刻变 xhigh', async () => {
    let serverSessionEffort: Effort = 'high';
    const mergeSessionEffort = vi.fn().mockImplementation((effort: Effort) => {
      serverSessionEffort = effort;
    });
    const localVendorDefaults: DraftVendorPrefs = {
      model: 'claude-fable-5',
      effort: 'high',
      permissionMode: 'auto',
    };

    let derived = deriveActive({ initialEffort: serverSessionEffort, localVendorDefaults });
    expect(derived.activeEffort).toBe('high');

    await handleEffortChange(
      {
        sessionId: 'sess-1',
        sessionUpdate: vi.fn().mockResolvedValue(undefined),
        onEffortDidChange: mergeSessionEffort,
      },
      'xhigh',
    );

    derived = deriveActive({ initialEffort: serverSessionEffort, localVendorDefaults });
    expect(derived.activeEffort).toBe('xhigh');
    expect(mergeSessionEffort).toHaveBeenCalledWith('xhigh', 'sess-1');
    expect(mergeSessionEffort).toHaveBeenCalledTimes(1);
  });

  it('草稿态:点档位 → 父组件 patchVendorPrefs 更新 lastByVendor → props 流回新值(全程零网络)', async () => {
    // 模拟 NewMakerDraftRoute:onEffortDidChange → patchActivePrefs 落 lastByVendor(localStorage)。
    const draftPrefs: DraftVendorPrefs = {
      model: 'claude-fable-5',
      effort: 'medium',
      permissionMode: 'auto',
    };
    const patchActivePrefs = vi.fn().mockImplementation((eff: Effort) => {
      draftPrefs.effort = eff;
    });

    await handleEffortChange(
      { sessionUpdate: vi.fn(), onEffortDidChange: patchActivePrefs },
      'xhigh',
    );

    const derived = deriveActive({
      initialModel: draftPrefs.model,
      initialEffort: draftPrefs.effort,
      localVendorDefaults: draftPrefs,
    });
    expect(derived.activeEffort).toBe('xhigh');
    expect(patchActivePrefs).toHaveBeenCalledTimes(1);
  });

  it('回归：如果父组件忘记接 onEffortDidChange（未来重构风险），UI 会卡住——本测试守护这条契约', async () => {
    const serverSessionEffort: Effort = 'medium';
    const localVendorDefaults: DraftVendorPrefs = {
      model: 'claude-opus-4-7',
      effort: 'medium',
      permissionMode: 'auto',
    };

    await handleEffortChange(
      {
        sessionId: 'sess-1',
        sessionUpdate: vi.fn().mockResolvedValue(undefined),
        // onEffortDidChange 故意未接 — 模拟未来某次重构忘了 wire 的回归风险
      },
      'xhigh',
    );

    const derived = deriveActive({ initialEffort: serverSessionEffort, localVendorDefaults });
    expect(derived.activeEffort).toBe('medium');
  });
});
