/**
 * device-link 订阅 registry 单测(纯数据结构,无 client 依赖)。
 * 覆盖:topic 订阅/取消、legacy '*'、topic-scoped 命中、横幅控制端判定(纯 sessions 不算)、
 * 清理。这是 push 驱动 fan-out 的依据,回归必须显式。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as subs from '../device-link/subscriptions';

beforeEach(() => subs.__testing.reset());

describe('subscriptions registry', () => {
  it('ignores empty subscriptions so they cannot become phantom remote viewers', () => {
    subs.subscribe('empty', [], 'Nobody');
    expect(subs.getControllerIds()).toEqual([]);
  });

  it('subscribe 累加 topic;getControllersForTopic 命中订阅者', () => {
    subs.subscribe('ctrl-a', ['sessions'], 'MacA');
    subs.subscribe('ctrl-b', ['session:s1'], 'MacB');

    expect(subs.getControllersForTopic('sessions')).toEqual(['ctrl-a']);
    expect(subs.getControllersForTopic('session:s1')).toEqual(['ctrl-b']);
    expect(subs.getControllersForTopic('session:other')).toEqual([]);
  });

  it('legacy "*" 订阅者命中任意 topic', () => {
    subs.subscribe('legacy', ['*'], 'Old');
    expect(subs.getControllersForTopic('sessions')).toContain('legacy');
    expect(subs.getControllersForTopic('session:zzz')).toContain('legacy');
  });

  it('横幅只认 session / "*";更新 busy 额外保护 fs-watch', () => {
    subs.subscribe('observer', ['sessions'], 'Obs');
    expect(subs.getControlControllers()).toEqual([]); // 只看列表 → 不亮横幅

    subs.subscribe('controller', ['session:s1'], 'Ctrl');
    expect(subs.getControlControllers()).toEqual([{ deviceId: 'controller', name: 'Ctrl' }]);

    subs.subscribe('file-browser', ['fs-watch:/repo'], 'Files');
    expect(subs.getControlControllers()).not.toContainEqual({
      deviceId: 'file-browser',
      name: 'Files',
    });
    expect(subs.getUpdateRelaunchControllers()).toContainEqual({
      deviceId: 'file-browser',
      name: 'Files',
    });

    subs.subscribe('legacy', ['*'], 'Old');
    expect(subs.getControlControllers().map((c) => c.deviceId).sort()).toEqual([
      'controller',
      'legacy',
    ]);
    expect(subs.getUpdateRelaunchControllers().map((c) => c.deviceId).sort()).toEqual([
      'controller',
      'file-browser',
      'legacy',
    ]);
    expect(subs.getControllerIds().sort()).toEqual(['controller', 'file-browser', 'legacy', 'observer']);
  });

  it('unsubscribe 移除指定 topic;清空后整条移除', () => {
    subs.subscribe('ctrl', ['sessions', 'session:s1']);
    subs.unsubscribe('ctrl', ['session:s1']);
    expect(subs.__testing.topicsOf('ctrl')).toEqual(['sessions']);
    expect(subs.getControlControllers()).toEqual([]); // session topic 已去

    subs.unsubscribe('ctrl', ['sessions']);
    expect(subs.getControllerIds()).toEqual([]); // topic 清空 → 整条移除
    expect(subs.isEmpty()).toBe(true);
  });

  it('clearController / clearAll', () => {
    subs.subscribe('a', ['sessions']);
    subs.subscribe('b', ['session:s1']);
    expect(subs.clearController('a')).toBe(true);
    expect(subs.clearController('a')).toBe(false); // 已无
    expect(subs.getControllerIds()).toEqual(['b']);
    subs.clearAll();
    expect(subs.isEmpty()).toBe(true);
  });

  it('name 在 subscribe 提供时更新,缺省回落 deviceId 前缀', () => {
    subs.subscribe('dev-1234567890', ['session:s1']); // 无 name
    expect(subs.getControlControllers()[0]).toEqual({ deviceId: 'dev-1234567890', name: 'dev-1234' });
    subs.subscribe('dev-1234567890', ['session:s2'], 'RealName');
    expect(subs.getControlControllers()[0].name).toBe('RealName');
  });
});
