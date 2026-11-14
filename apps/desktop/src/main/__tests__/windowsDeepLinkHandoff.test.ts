/**
 * 测试价值：生产 createWindowsDeepLinkHandoff 把普通权限启动的链接交给提权主进程，
 * 同一启动的 Electron/pipe 双投递只处理一次。依据：Windows 邀请与 OAuth 唤起失败。
 * 现有 deepLink 测试仅覆盖进程内解析，没有进程交接、重复投递与关闭后的回调。
 * 最小输入：同一个启动 ID 经 second-instance 和 pipe 各到达一次。
 * tier: unit；原生传输用内存替身，真实 Windows 权限交接另作 integration 验证。
 * 实测耗时：单独 vitest run 本文件 1.17 s（Windows，8 项用例）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { matchDeepLinkPrefix } from '../../shared/deepLinkSchemes';
import { createWindowsDeepLinkHandoff, deepLinkRequestData } from '../windowsDeepLinkHandoff';

function setup(elevated = true, lockScopeDir = 'C:\\fixture\\profile') {
  let receive: (message: string) => void = () => { throw new Error('listener not started'); };
  const close = vi.fn();
  const native = {
    isProcessElevated: vi.fn(() => elevated),
    startDeepLinkServer: vi.fn((_scope: string, callback: typeof receive) => {
      receive = callback;
      return { close };
    }),
    sendDeepLink: vi.fn((_scope: string, _message: string) => true),
  };
  const dispatch = vi.fn();
  const onFailure = vi.fn();
  const handoff = createWindowsDeepLinkHandoff({
    lockScopeDir, native, dispatch, onFailure,
    isDeepLink: (url) => matchDeepLinkPrefix(url) !== null,
  });
  handoff.start();
  return { handoff, native, dispatch, onFailure, close, receive: (message: string) => receive(message) };
}

afterEach(() => vi.useRealTimers());

describe('Windows elevated-instance deep-link handoff', () => {
  it.each(['electron-first', 'pipe-first'])('handles one launch once with %s arrival order, while allowing a fresh click', (order) => {
    const fixture = setup();
    const url = 'cindy://focus/oauth';
    const data = deepLinkRequestData();
    const electron = () => fixture.handoff.dispatch(url, data, 'second-instance');
    const pipe = () => fixture.receive(JSON.stringify({ ...data, url }));
    if (order === 'electron-first') { electron(); pipe(); } else { pipe(); electron(); }
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    expect(fixture.dispatch).toHaveBeenCalledWith(url, order === 'electron-first' ? 'second-instance' : 'windows-handoff');
    fixture.receive(JSON.stringify({ ...deepLinkRequestData(), url }));
    expect(fixture.dispatch).toHaveBeenCalledTimes(2);
  });

  it('does not listen or alter ordinary second-instance dispatch in a normal primary', () => {
    const fixture = setup(false);
    expect(fixture.native.startDeepLinkServer).not.toHaveBeenCalled();
    fixture.handoff.dispatch('cindy://focus', undefined, 'second-instance');
    fixture.handoff.dispatch('cindy://focus', undefined, 'second-instance');
    expect(fixture.dispatch).toHaveBeenCalledTimes(2);
  });

  it('does not replay a handoff when Electron delivers second-instance after a slow startup', () => {
    vi.useFakeTimers();
    const fixture = setup();
    const data = deepLinkRequestData();
    const url = 'cindy://focus/oauth';
    fixture.receive(JSON.stringify({ ...data, url }));
    vi.advanceTimersByTime(120_000);
    fixture.handoff.dispatch(url, data, 'second-instance');
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith(url, 'windows-handoff');
  });

  it('sends only bounded deep links from normal launches, retaining the launch ID', () => {
    const fixture = setup(false);
    const data = deepLinkRequestData();
    const url = 'cindy://shared-task/join?invitation=synthetic';
    expect(fixture.handoff.forward(url, data)).toBe(true);
    expect(JSON.parse(fixture.native.sendDeepLink.mock.calls[0][1])).toEqual({ ...data, url });
    for (const invalid of ['https://example.invalid', 'cindy://focus\0oops', `cindy://focus/${'a'.repeat(32_768)}`]) {
      expect(fixture.handoff.forward(invalid, data)).toBe(false);
    }
    expect(fixture.handoff.forward(url, undefined)).toBe(false);
    expect(fixture.native.sendDeepLink).toHaveBeenCalledTimes(1);
    fixture.native.isProcessElevated.mockReturnValue(true);
    expect(fixture.handoff.forward(url, data)).toBe(false);
    expect(fixture.native.sendDeepLink).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed input and ignores callbacks after the owner closes', () => {
    const fixture = setup();
    const data = deepLinkRequestData();
    for (const invalid of ['{', 'null', '{}', JSON.stringify({ ...data, url: 'https://example.invalid' }), JSON.stringify({ ...data, url: 'cindy://focus\0oops' }), JSON.stringify({ ...data, url: `cindy://focus/${'a'.repeat(32_768)}` })]) {
      fixture.receive(invalid);
    }
    expect(fixture.dispatch).not.toHaveBeenCalled();
    fixture.handoff.close();
    fixture.receive(JSON.stringify({ ...data, url: 'cindy://focus' }));
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it('isolates profiles and dev lock scopes while matching Windows path casing', () => {
    const scopes = ['C:\\fixture\\profile', 'c:\\FIXTURE\\PROFILE', 'C:\\fixture\\profile\\dev-single-instance-lock', 'C:\\fixture\\another'];
    const names = scopes.map((scope) => setup(true, scope).native.startDeepLinkServer.mock.calls[0][0]);
    expect(names[0]).toBe(names[1]);
    expect(new Set(names).size).toBe(3);
    expect(names.every((name) => /^[a-f0-9]{64}$/.test(name))).toBe(true);
  });

  it('does not expose native exception text containing a link secret', () => {
    const fixture = setup(false);
    fixture.native.sendDeepLink.mockImplementation(() => { throw new Error('synthetic-secret'); });
    expect(fixture.handoff.forward('cindy://focus', deepLinkRequestData())).toBe(false);
    expect(fixture.onFailure).toHaveBeenCalledExactlyOnceWith('send');
  });
});
