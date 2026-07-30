import { describe, expect, it } from 'vitest';

import { resolveDisplayContextWindow } from '@/lib/contextWindow';
import { makerChatStore } from '@/lib/makerChatStore';

describe('resolveDisplayContextWindow', () => {
  // SDK 的 unknown-model 默认值最不可信: 目录值哪怕未经核实(这两条就没传 verified),
  // 也比它更能反映该模型 —— 这一层判定刻意排在「目录能否当上限」之前。
  it('prefers maker capability when SDK reports the unknown-model 200K default', () => {
    expect(resolveDisplayContextWindow({
      modelContextWindow: 992_000,
      sdkContextWindow: 200_000,
    })).toBe(992_000);
  });

  it('does not let a stale 200K value from the previous model hide DeepSeek 1M context', () => {
    expect(resolveDisplayContextWindow({
      modelContextWindow: 1_048_576,
      sdkContextWindow: 200_000,
    })).toBe(1_048_576);
  });

  // app-server 报的是**基础模型**窗口, 忽略网关对该路由的实际限制。目录里**显式声明**的
  // 372K 才是真实上限, 不能被这种虚高值盖掉 —— 否则圆环把 372K 会话显示成 1M,
  // 用户在真实上限前就被压缩, 却以为还剩 60% 余量。
  it('caps the SDK value at the catalog window for gateway-routed models', () => {
    expect(resolveDisplayContextWindow({
      modelContextWindow: 372_000,
      modelContextWindowVerified: true,
      sdkContextWindow: 1_000_000,
    })).toBe(372_000);
  });

  it('caps to the catalog window even when the gap is small', () => {
    expect(resolveDisplayContextWindow({
      modelContextWindow: 992_000,
      modelContextWindowVerified: true,
      sdkContextWindow: 1_000_000,
    })).toBe(992_000);
  });

  // 目录里的窗口有一半是派生兜底: 自定义 provider 未填时的 200K 占位、codex `model/list`
  // 一律给的 272K。它们数值上与真实上限无从区分, 只能靠 verified 标记区分 —— 拿兜底值
  // 当上限会把 SDK 实测的真实窗口压小, 圆环余量凭空缩水, 比原本的虚高更糟。
  it('does not let an unverified 200K placeholder cap a real 1M SDK window', () => {
    expect(resolveDisplayContextWindow({
      modelContextWindow: 200_000,
      sdkContextWindow: 1_000_000,
    })).toBe(1_000_000);
  });

  // codex `model/list` 对**每个**发现的模型都填 272K(该协议不暴露窗口元数据),
  // 所以一个运行期报 400K 的模型不能被这个兜底值压到 272K。
  it('does not let the unverified 272K discovery fallback cap a larger real window', () => {
    expect(resolveDisplayContextWindow({
      modelContextWindow: 272_000,
      sdkContextWindow: 400_000,
    })).toBe(400_000);
  });

  it('keeps a smaller SDK value when the route is actually downsized', () => {
    expect(resolveDisplayContextWindow({
      modelContextWindow: 1_000_000,
      modelContextWindowVerified: true,
      sdkContextWindow: 400_000,
    })).toBe(400_000);
  });

  it('trusts the SDK value when the catalog has no entry for the model', () => {
    expect(resolveDisplayContextWindow({
      modelContextWindow: undefined,
      sdkContextWindow: 1_000_000,
    })).toBe(1_000_000);
  });

  it('falls back to the model capability before the hardcoded default', () => {
    expect(resolveDisplayContextWindow({
      modelContextWindow: 262_144,
      sdkContextWindow: 0,
    })).toBe(262_144);
  });

  it('falls back to the hardcoded default when neither source is known', () => {
    expect(resolveDisplayContextWindow({
      modelContextWindow: undefined,
      sdkContextWindow: 0,
    })).toBe(200_000);
  });
});

describe('makerChatStore context window refresh', () => {
  it('updates the displayed context window without waiting for the next turn', () => {
    const sessionId = 'context-window-switch-test';
    makerChatStore.purgeSession(sessionId);

    makerChatStore.setContextWindow(sessionId, 1_048_576);

    expect(makerChatStore.getSnapshot(sessionId).agentStatus.contextWindow).toBe(1_048_576);
    makerChatStore.purgeSession(sessionId);
  });
});
