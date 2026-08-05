/**
 * sessionModelMirror 单测:会话隔离、增量 push 应用(非法 payload 忽略)、clearSessionMirror、
 * accessors 乐观写 + onWrite 触发。node env,mock react(只用非 hook API)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react', () => ({ useSyncExternalStore: vi.fn() }));

import {
  __resetForTest,
  applySessionModelPrefPush,
  clearSessionMirror,
  makeSessionMirrorAccessors,
} from '@/session/sessionModelMirror';

describe('sessionModelMirror', () => {
  beforeEach(() => {
    __resetForTest();
  });

  it('accessors 乐观写镜像 + 触发 onWrite(patch 只带改动字段)', () => {
    const onWrite = vi.fn();
    const acc = makeSessionMirrorAccessors('s1', onWrite);
    acc.setEffort('codex', 'openai', 'gpt-5.5', 'xhigh');
    expect(acc.getEffort('codex', 'openai', 'gpt-5.5')).toBe('xhigh');
    expect(onWrite).toHaveBeenLastCalledWith('codex', 'openai', 'gpt-5.5', { effort: 'xhigh' });
    acc.setFast('codex', 'openai', 'gpt-5.5', true);
    expect(acc.getFast('codex', 'openai', 'gpt-5.5')).toBe(true);
    expect(onWrite).toHaveBeenLastCalledWith('codex', 'openai', 'gpt-5.5', { fast: true });
  });

  it('按 sessionId 隔离;clearSessionMirror 只清该会话', () => {
    const a = makeSessionMirrorAccessors('s1', vi.fn());
    const b = makeSessionMirrorAccessors('s2', vi.fn());
    a.setEffort('codex', 'openai', 'gpt-5.5', 'high');
    expect(b.getEffort('codex', 'openai', 'gpt-5.5')).toBeUndefined();
    b.setEffort('codex', 'openai', 'gpt-5.5', 'low');
    clearSessionMirror('s1');
    expect(a.getEffort('codex', 'openai', 'gpt-5.5')).toBeUndefined();
    expect(b.getEffort('codex', 'openai', 'gpt-5.5')).toBe('low');
  });

  it('applySessionModelPrefPush:增量应用被控端回流(effort / fast 可各自单独带)', () => {
    const acc = makeSessionMirrorAccessors('s1', vi.fn());
    applySessionModelPrefPush({
      sessionId: 's1', agent: 'codex', providerId: 'xd', model: 'gpt-5.5', effort: 'medium',
    });
    expect(acc.getEffort('codex', 'xd', 'gpt-5.5')).toBe('medium');
    expect(acc.getFast('codex', 'xd', 'gpt-5.5')).toBeUndefined();
    applySessionModelPrefPush({
      sessionId: 's1', agent: 'codex', providerId: 'xd', model: 'gpt-5.5', fast: true,
    });
    expect(acc.getFast('codex', 'xd', 'gpt-5.5')).toBe(true);
    expect(acc.getEffort('codex', 'xd', 'gpt-5.5')).toBe('medium'); // 增量不清旧值

    applySessionModelPrefPush({
      sessionId: 's1', agent: 'pi', providerId: 'openai', model: 'gpt-5.6', effort: 'high', fast: true,
    });
    expect(acc.getEffort('pi', 'openai', 'gpt-5.6')).toBe('high');
    expect(acc.getFast('pi', 'openai', 'gpt-5.6')).toBe(true);
  });

  it('applySessionModelPrefPush:非法 payload 静默忽略', () => {
    const acc = makeSessionMirrorAccessors('s1', vi.fn());
    for (const bad of [
      null,
      'x',
      {},
      { sessionId: 's1' },
      { sessionId: 's1', agent: 'gemini', providerId: 'xd', model: 'm', effort: 'high' },
      { sessionId: 's1', agent: 'codex', providerId: '', model: 'm', effort: 'high' },
      { sessionId: 's1', agent: 'codex', providerId: 'xd', model: '', effort: 'high' },
      { sessionId: 's1', agent: 'codex', providerId: 'xd', model: 'm', effort: 42 },
    ]) {
      applySessionModelPrefPush(bad);
    }
    expect(acc.getEffort('codex', 'xd', 'm')).toBeUndefined();
  });
});
