import { beforeEach, describe, expect, it } from 'vitest';

import { isShareableMessage, shareSelectionStore } from '../shareSelectionStore';

beforeEach(() => {
  shareSelectionStore.reset();
});

describe('isShareableMessage', () => {
  it('只认正文对话:user / assistant', () => {
    expect(isShareableMessage({ role: 'user', clientId: 'x' })).toBe(true);
    expect(isShareableMessage({ role: 'assistant', clientId: 'x' })).toBe(true);
  });

  it('思考 / 工具 / 错误 / 计划 / 提问卡都不可选', () => {
    for (const role of [
      'thinking',
      'tool_use',
      'tool_result',
      'error',
      'plan_review',
      'ask_user',
    ]) {
      expect(isShareableMessage({ role, clientId: 'x' })).toBe(false);
    }
  });

  it('SystemCard 行与合成指令行不可选(没有可克隆的正文气泡)', () => {
    expect(isShareableMessage({ role: 'user', clientId: 'x', systemCardType: 'auto-resume' })).toBe(
      false,
    );
    expect(
      isShareableMessage({ role: 'assistant', clientId: 'x', systemCardType: 'handoff' }),
    ).toBe(false);
    expect(isShareableMessage({ role: 'user', clientId: 'x', isSyntheticTrigger: true })).toBe(
      false,
    );
  });

  it('默认折叠的 Orca communication 用户卡不可选', () => {
    expect(
      isShareableMessage({
        role: 'user',
        clientId: 'x',
        content: JSON.stringify({ orcaSource: 'lead', content: '分派任务' }),
      }),
    ).toBe(false);
  });
});

describe('shareSelectionStore', () => {
  it('默认未进入选择模式', () => {
    expect(shareSelectionStore.getActiveSessionId()).toBeNull();
    expect(shareSelectionStore.isActive('s1')).toBe(false);
    expect(shareSelectionStore.count()).toBe(0);
  });

  it('enter 预选入口那条消息', () => {
    shareSelectionStore.enter('s1', 'm1');
    expect(shareSelectionStore.isActive('s1')).toBe(true);
    expect(shareSelectionStore.isSelected('m1')).toBe(true);
    expect(shareSelectionStore.count()).toBe(1);
  });

  it('enter 不带预选时进入空选状态', () => {
    shareSelectionStore.enter('s1');
    expect(shareSelectionStore.isActive('s1')).toBe(true);
    expect(shareSelectionStore.count()).toBe(0);
  });

  it('isActive 只认当前会话', () => {
    shareSelectionStore.enter('s1', 'm1');
    expect(shareSelectionStore.isActive('s2')).toBe(false);
    expect(shareSelectionStore.isActive(undefined)).toBe(false);
  });

  it('toggle 双向切换', () => {
    shareSelectionStore.enter('s1');
    shareSelectionStore.toggle('m1');
    expect(shareSelectionStore.isSelected('m1')).toBe(true);
    shareSelectionStore.toggle('m1');
    expect(shareSelectionStore.isSelected('m1')).toBe(false);
    expect(shareSelectionStore.count()).toBe(0);
  });

  it('切到另一个会话时清空旧选中态', () => {
    shareSelectionStore.enter('s1', 'm1');
    shareSelectionStore.toggle('m2');
    expect(shareSelectionStore.count()).toBe(2);

    shareSelectionStore.enter('s2', 'x1');
    expect(shareSelectionStore.isActive('s2')).toBe(true);
    expect(shareSelectionStore.isSelected('m1')).toBe(false);
    expect(shareSelectionStore.isSelected('m2')).toBe(false);
    expect(shareSelectionStore.count()).toBe(1);
  });

  it('对同一会话再次 enter 保留已选,只补上预选那条', () => {
    shareSelectionStore.enter('s1', 'm1');
    shareSelectionStore.toggle('m2');
    shareSelectionStore.enter('s1', 'm3');
    expect(shareSelectionStore.count()).toBe(3);
    expect(shareSelectionStore.isSelected('m1')).toBe(true);
  });

  it('exit 清空模式与选中态', () => {
    shareSelectionStore.enter('s1', 'm1');
    shareSelectionStore.exit();
    expect(shareSelectionStore.getActiveSessionId()).toBeNull();
    expect(shareSelectionStore.count()).toBe(0);
    expect(shareSelectionStore.isSelected('m1')).toBe(false);
  });

  it('setSelection 覆盖式全选,clearSelection 只清选中不退出模式', () => {
    shareSelectionStore.enter('s1', 'm1');
    shareSelectionStore.setSelection(['a', 'b', 'c']);
    expect(shareSelectionStore.count()).toBe(3);
    expect(shareSelectionStore.isSelected('m1')).toBe(false);

    shareSelectionStore.clearSelection();
    expect(shareSelectionStore.count()).toBe(0);
    expect(shareSelectionStore.isActive('s1')).toBe(true);
  });

  it('getSelectedIds 返回可用于恢复的独立快照', () => {
    shareSelectionStore.enter('s1', 'm1');
    shareSelectionStore.toggle('m2');
    const snapshot = shareSelectionStore.getSelectedIds();

    shareSelectionStore.setSelection(['all-1', 'all-2']);
    expect(snapshot).toEqual(['m1', 'm2']);
    expect(shareSelectionStore.getSelectedIds()).toEqual(['all-1', 'all-2']);
  });

  it('getSelectedIdsInOrder 按消息流顺序返回,而不是点击顺序', () => {
    shareSelectionStore.enter('s1');
    // 倒序勾选
    shareSelectionStore.toggle('m3');
    shareSelectionStore.toggle('m1');
    shareSelectionStore.toggle('m2');
    expect(shareSelectionStore.getSelectedIdsInOrder(['m1', 'm2', 'm3', 'm4'])).toEqual([
      'm1',
      'm2',
      'm3',
    ]);
  });

  it('getSelectedIdsInOrder 忽略不在有序全集里的残留 id', () => {
    shareSelectionStore.enter('s1');
    shareSelectionStore.setSelection(['gone', 'm1']);
    expect(shareSelectionStore.getSelectedIdsInOrder(['m1', 'm2'])).toEqual(['m1']);
  });

  it('exitIfNotSession 只在会话不匹配时退出', () => {
    shareSelectionStore.enter('s1', 'm1');
    shareSelectionStore.exitIfNotSession('s1');
    expect(shareSelectionStore.isActive('s1')).toBe(true);

    shareSelectionStore.exitIfNotSession('s2');
    expect(shareSelectionStore.getActiveSessionId()).toBeNull();
  });

  it('未进入选择模式时 exitIfNotSession 是 no-op', () => {
    shareSelectionStore.exitIfNotSession('s1');
    expect(shareSelectionStore.getActiveSessionId()).toBeNull();
  });

  it('订阅者在状态变化时收到通知', () => {
    let calls = 0;
    const unsubscribe = shareSelectionStore.subscribe(() => {
      calls += 1;
    });
    shareSelectionStore.enter('s1', 'm1');
    shareSelectionStore.toggle('m2');
    expect(calls).toBe(2);
    unsubscribe();
    shareSelectionStore.toggle('m3');
    expect(calls).toBe(2);
  });
});
