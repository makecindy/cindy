/**
 * makerChatStore.mirrorSessionFields 单测(device-link fastMode 回流镜像)。
 * fast 开关读 chat in-memory;被控端 sessions:patched{fastMode} 回流时必须镜像进来,
 * 才能跨端同步(之前只更新分片/serverSession、不灌 chat-mem → 开关不同步)。
 * 幂等(值未变 = no-op,不与本机乐观切换打架);patch 不含 fastMode 时不动。
 */
import { describe, it, expect } from 'vitest';
import { buildCreateOptsForCurrentSession, makerChatStore } from '@/lib/makerChatStore';

// 模块级 sessions Map 跨用例持久 → 每个用例用唯一 sessionId 隔离。
let n = 0;
const sid = () => `mirror-test-${n++}`;

describe('makerChatStore.mirrorSessionFields', () => {
  it('patched{fastMode:true} 镜像进快照;切回 false 同样', () => {
    const s = sid();
    makerChatStore.mirrorSessionFields(s, { fastMode: true });
    expect(makerChatStore.getSnapshot(s).fastMode).toBe(true);
    makerChatStore.mirrorSessionFields(s, { fastMode: false });
    expect(makerChatStore.getSnapshot(s).fastMode).toBe(false);
  });

  it('幂等:值未变 = no-op(快照引用不变,绝不与乐观切换打架)', () => {
    const s = sid();
    makerChatStore.mirrorSessionFields(s, { fastMode: true });
    const snap1 = makerChatStore.getSnapshot(s);
    makerChatStore.mirrorSessionFields(s, { fastMode: true }); // 同值
    expect(makerChatStore.getSnapshot(s)).toBe(snap1); // 引用不变 = 未触发更新
  });

  it('patch 不含 fastMode(或非 boolean)→ 不动 fastMode', () => {
    const s = sid();
    makerChatStore.mirrorSessionFields(s, { fastMode: true });
    makerChatStore.mirrorSessionFields(s, { title: 'x' } as { fastMode?: unknown });
    makerChatStore.mirrorSessionFields(s, { fastMode: 'yes' } as { fastMode?: unknown });
    expect(makerChatStore.getSnapshot(s).fastMode).toBe(true); // 仍是上次的 true
  });

  it('切换意图只进入展示槽,不改真实 reducer agentKind/sdkSessionId', () => {
    const s = sid();
    makerChatStore.setSessionRuntime(s, { agentKind: 'claude-code' });
    makerChatStore.noteAgentSwitchIntent(s, 'codex', {
      model: 'gpt-5.5',
      providerId: 'openai',
      effort: 'high',
      fastMode: true,
    });
    const snapshot = makerChatStore.getSnapshot(s);
    expect(snapshot.agentKind).toBe('claude-code');
    expect(snapshot.agentSwitchIntent).toMatchObject({ target: 'codex', model: 'gpt-5.5' });
  });

  it('旧引擎 patch 更新真实槽但保留 intent；目标 patch 收敛并清 intent', () => {
    const s = sid();
    makerChatStore.noteAgentSwitchIntent(s, 'codex', { model: 'gpt-5.5', providerId: null });
    makerChatStore.mirrorSessionFields(s, { agentKind: 'cc' });
    expect(makerChatStore.getSnapshot(s).agentKind).toBe('claude-code');
    expect(makerChatStore.getSnapshot(s).agentSwitchIntent?.target).toBe('codex');
    makerChatStore.mirrorSessionFields(s, { agentKind: 'codex' });
    expect(makerChatStore.getSnapshot(s).agentKind).toBe('codex');
    expect(makerChatStore.getSnapshot(s).agentSwitchIntent).toBeNull();
  });

  it('applies the switched provider snapshot so later createOpts do not keep the old source', () => {
    const s = sid();
    makerChatStore.mirrorSessionFields(s, { providerId: 'xd' });
    makerChatStore.noteAgentSwitchIntent(s, 'codex', {
      model: 'gpt-5.5',
      providerId: 'openai',
    });
    makerChatStore.mirrorSessionFields(s, { agentKind: 'codex' });
    expect(makerChatStore.getSnapshot(s).sessionProviderId).toBe('openai');
    expect(makerChatStore.getSnapshot(s).agentSwitchIntent).toBeNull();
    expect(buildCreateOptsForCurrentSession(s, 'gpt-5.5', 'high', 'default', '/tmp').providerId).toBe(
      'openai',
    );
  });

  it('mirrors an explicit same-agent provider patch into later createOpts', () => {
    const s = sid();
    makerChatStore.mirrorSessionFields(s, { providerId: 'xd' });
    makerChatStore.mirrorSessionFields(s, { providerId: 'custom-litellm' });
    expect(makerChatStore.getSnapshot(s).sessionProviderId).toBe('custom-litellm');
    expect(
      buildCreateOptsForCurrentSession(s, 'gpt-5.5', 'high', 'default', '/tmp').providerId,
    ).toBe('custom-litellm');
  });

  it('SET_MODEL 取消广播只清展示 intent,不改真实引擎', () => {
    const s = sid();
    makerChatStore.noteAgentSwitchIntent(s, 'codex', { model: 'gpt-5.5', providerId: null });
    makerChatStore.mirrorSessionFields(s, { agentSwitchIntentCanceled: true });
    expect(makerChatStore.getSnapshot(s).agentKind).toBe('claude-code');
    expect(makerChatStore.getSnapshot(s).agentSwitchIntent).toBeNull();
  });
});
