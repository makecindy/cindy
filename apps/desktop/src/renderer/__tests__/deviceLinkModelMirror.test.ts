/**
 * deviceLinkModelMirror 单测:控制端「纯显示镜像」的读写 / scope 隔离 / replaceScope 全量 seed /
 * clearScope 清理 / makeMirrorAccessors 写穿回调。这是 device-link 模型列表双向同步在控制端的显示
 * 真相源,回归必须显式守住「按 scope 隔离、写镜像同时触发 onWrite」。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  replaceScope,
  clearScope,
  getMirrorEffort,
  getMirrorFast,
  setMirrorEffort,
  setMirrorFast,
  makeMirrorAccessors,
  __resetForTest,
} from '@/state/deviceLinkModelMirror';

const DRAFT = 'draft:dev-1';
const SESSION = 'session:s-1';

beforeEach(() => {
  __resetForTest();
});

describe('replaceScope / get*', () => {
  it('用被控端全量快照 seed,按 (agent, provider, model) 读回', () => {
    replaceScope(DRAFT, {
      'claude-code:anthropic': { effortByModel: { 'claude-opus-4-8': 'high' }, fastByModel: {} },
      'codex:openai': { effortByModel: {}, fastByModel: { 'gpt-5.4': true } },
    });
    expect(getMirrorEffort(DRAFT, 'claude-code', 'anthropic', 'claude-opus-4-8')).toBe('high');
    expect(getMirrorFast(DRAFT, 'codex', 'openai', 'gpt-5.4')).toBe(true);
    // 未记录 → undefined(可与 false 区分,供 ?? 兜底)
    expect(getMirrorEffort(DRAFT, 'claude-code', 'anthropic', 'unknown')).toBeUndefined();
    expect(getMirrorFast(DRAFT, 'codex', 'openai', 'unknown')).toBeUndefined();
  });

  it('只读真实 provider 槽,不采用 * 全局槽', () => {
    replaceScope(DRAFT, {
      'claude-code:*': { effortByModel: { opus: 'xhigh' }, fastByModel: { opus: true } },
      'claude-code:anthropic': { effortByModel: { opus: 'high' }, fastByModel: { opus: false } },
    });
    expect(getMirrorEffort(DRAFT, 'claude-code', 'anthropic', 'opus')).toBe('high');
    expect(getMirrorEffort(DRAFT, 'claude-code', 'xd', 'opus')).toBeUndefined();
    expect(getMirrorFast(DRAFT, 'claude-code', 'xd', 'opus')).toBeUndefined();
  });

  it('replaceScope(undefined) 等于清空该 scope', () => {
    replaceScope(DRAFT, { 'claude-code:anthropic': { effortByModel: { m: 'low' }, fastByModel: {} } });
    replaceScope(DRAFT, undefined);
    expect(getMirrorEffort(DRAFT, 'claude-code', 'anthropic', 'm')).toBeUndefined();
  });

  it('同值短路:乐观 setMirror 后,被控端 echo 原快照仍能纠回(失效同值缓存)', () => {
    // 这是 replaceScope 同值短路最易错的点:乐观写后缓存必须失效,否则"echo 回旧值"会被误短路、纠不回。
    replaceScope(DRAFT, { 'claude-code:anthropic': { effortByModel: { opus: 'high' }, fastByModel: {} } });
    setMirrorEffort(DRAFT, 'claude-code', 'anthropic', 'opus', 'low'); // 控制端乐观写
    expect(getMirrorEffort(DRAFT, 'claude-code', 'anthropic', 'opus')).toBe('low');
    // 被控端 echo 回它的权威值(= 原 high,例如控制端写穿被拒/未落)→ 必须纠回,不能被同值缓存短路
    replaceScope(DRAFT, { 'claude-code:anthropic': { effortByModel: { opus: 'high' }, fastByModel: {} } });
    expect(getMirrorEffort(DRAFT, 'claude-code', 'anthropic', 'opus')).toBe('high');
  });
});

describe('scope 隔离', () => {
  it('draft 与 session 两个 scope 互不影响', () => {
    setMirrorEffort(DRAFT, 'claude-code', 'anthropic', 'opus', 'high');
    setMirrorEffort(SESSION, 'claude-code', 'anthropic', 'opus', 'low');
    expect(getMirrorEffort(DRAFT, 'claude-code', 'anthropic', 'opus')).toBe('high');
    expect(getMirrorEffort(SESSION, 'claude-code', 'anthropic', 'opus')).toBe('low');
  });

  it('同 agent/model 按 provider 隔离,不同 agent 也隔离', () => {
    setMirrorFast(DRAFT, 'claude-code', 'anthropic', 'opus', true);
    expect(getMirrorFast(DRAFT, 'claude-code', 'xd', 'opus')).toBeUndefined();
    setMirrorFast(DRAFT, 'claude-code', 'xd', 'opus', false);
    expect(getMirrorFast(DRAFT, 'claude-code', 'anthropic', 'opus')).toBe(true);
    expect(getMirrorFast(DRAFT, 'claude-code', 'xd', 'opus')).toBe(false);
    expect(getMirrorFast(DRAFT, 'codex', 'xd', 'opus')).toBeUndefined();
  });
});

describe('clearScope', () => {
  it('清掉指定 scope,不影响其它 scope', () => {
    setMirrorEffort(DRAFT, 'claude-code', 'anthropic', 'opus', 'high');
    setMirrorEffort(SESSION, 'claude-code', 'anthropic', 'opus', 'low');
    clearScope(DRAFT);
    expect(getMirrorEffort(DRAFT, 'claude-code', 'anthropic', 'opus')).toBeUndefined();
    expect(getMirrorEffort(SESSION, 'claude-code', 'anthropic', 'opus')).toBe('low');
  });
});

describe('makeMirrorAccessors', () => {
  it('setEffort:乐观写镜像 + 用 (agent, provider, model, {effort}) 调 onWrite', () => {
    const onWrite = vi.fn();
    const acc = makeMirrorAccessors(DRAFT, onWrite);
    acc.setEffort('claude-code', 'anthropic', 'opus', 'high');
    // 乐观镜像已写(getEffort 读回)
    expect(acc.getEffort('claude-code', 'anthropic', 'opus')).toBe('high');
    expect(getMirrorEffort(DRAFT, 'claude-code', 'anthropic', 'opus')).toBe('high');
    // onWrite 收到正确入参(后续由调用方经隧道写穿被控端)
    expect(onWrite).toHaveBeenCalledWith('claude-code', 'anthropic', 'opus', { effort: 'high' });
  });

  it('setFast:乐观写镜像 + 用 {fast} 调 onWrite', () => {
    const onWrite = vi.fn();
    const acc = makeMirrorAccessors(SESSION, onWrite);
    acc.setFast('codex', 'openai', 'gpt-5.4', true);
    expect(acc.getFast('codex', 'openai', 'gpt-5.4')).toBe(true);
    expect(onWrite).toHaveBeenCalledWith('codex', 'openai', 'gpt-5.4', { fast: true });
  });

  it('setThinking:乐观写镜像 + 用 {thinking} 调 onWrite', () => {
    const onWrite = vi.fn();
    const acc = makeMirrorAccessors(SESSION, onWrite);
    acc.setThinking?.('pi', 'cindy-local-ollama', 'qwen3.8:27b-mxfp8', false);
    expect(acc.getThinking?.('pi', 'cindy-local-ollama', 'qwen3.8:27b-mxfp8')).toBe(false);
    expect(onWrite).toHaveBeenCalledWith('pi', 'cindy-local-ollama', 'qwen3.8:27b-mxfp8', {
      thinking: false,
    });
  });

  it('setChoice:共享预设并显式标记真正选中模型', () => {
    const onWrite = vi.fn();
    const acc = makeMirrorAccessors(SESSION, onWrite);
    acc.setChoice?.('claude-code', 'anthropic', 'opus', 'high');
    expect(acc.getEffort('claude-code', 'anthropic', 'opus')).toBe('high');
    expect(acc.getEffort('claude-code', 'xd', 'opus')).toBeUndefined();
    expect(onWrite).toHaveBeenCalledWith('claude-code', 'anthropic', 'opus', {
      effort: 'high',
      markModelChoice: true,
    });
  });

  it('get* 透过 accessor 读对应 scope 的镜像(被控端 push 写入后能读到)', () => {
    const acc = makeMirrorAccessors(SESSION, vi.fn());
    // 模拟被控端 push 经 makerChatStore 写镜像
    setMirrorEffort(SESSION, 'claude-code', 'anthropic', 'opus', 'medium');
    expect(acc.getEffort('claude-code', 'anthropic', 'opus')).toBe('medium');
  });
});
