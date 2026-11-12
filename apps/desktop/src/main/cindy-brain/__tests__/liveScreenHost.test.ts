import { describe, expect, it, vi } from 'vitest';
import type { InstalledGhost } from '../../../shared/ghost';
import { isLiveScreenFrameUrl, LiveScreenHost, parseLiveScreenDescriptor } from '../liveScreenHost';

const ghost = (id: string, manifest: Record<string, unknown>, enabled = true) =>
  ({
    dir: `/plugins/${id}`,
    enabled,
    manifest: { id, name: `${id} name`, ...manifest },
  }) as unknown as InstalledGhost;

function host(plugins: InstalledGhost[], reply: (method: string, params: unknown) => unknown) {
  const request = vi.fn(async (_instance: string, method: string, params: unknown) => ({
    ok: true as const,
    result: reply(method, params),
  }));
  return {
    request,
    host: new LiveScreenHost({ plugins: () => plugins, request, locale: () => 'zh-CN' }),
  };
}

describe('live screen host', () => {
  it('asks only enabled plugins that declare both liveScreen and node, and keeps valid screens', async () => {
    const node = { entry: 'worker.cjs', protocol: 'json-rpc-stdio' };
    const { host: h, request } = host(
      [
        ghost('sim', { liveScreen: true, node }),
        ghost('nonode', { liveScreen: true }),
        ghost('undeclared', { node }),
        ghost('off', { liveScreen: true, node }, false),
      ],
      () => ({
        ok: true,
        screens: [
          {
            id: 'UDID-1',
            name: 'iPhone',
            platform: 'ios',
            state: 'running',
            taskIds: ['task-1', 'bad id!', 'task-1'],
          },
          { id: 'UDID-1', name: 'duplicate', platform: 'ios', state: 'running' },
          { id: 'x y', name: 'bad id', platform: 'ios', state: 'running' },
          { id: 'W', name: 'watch', platform: 'watchos', state: 'running' },
          { id: 'A', name: 'Pixel', platform: 'android', state: 'off' },
        ],
      }),
    );
    expect(await h.list()).toEqual([
      {
        plugin: 'sim',
        pluginName: 'sim name',
        id: 'UDID-1',
        name: 'iPhone',
        platform: 'ios',
        state: 'running',
        taskIds: ['task-1'],
      },
      {
        plugin: 'sim',
        pluginName: 'sim name',
        id: 'A',
        name: 'Pixel',
        platform: 'android',
        state: 'off',
        taskIds: [],
      },
    ]);
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith('sim', 'liveScreen.list', { _locale: 'zh-CN' }, 5000);
  });

  it('leaves out a plugin whose list fails instead of failing every screen', async () => {
    const node = { entry: 'worker.cjs', protocol: 'json-rpc-stdio' };
    const request = vi.fn(async (instance: string) =>
      instance === 'broken'
        ? { ok: false as const, errorCode: 'TIMEOUT' as const, message: 'slow' }
        : {
            ok: true as const,
            result: {
              ok: true,
              screens: [{ id: '1', name: 'n', platform: 'tvos', state: 'running' }],
            },
          },
    );
    const h = new LiveScreenHost({
      plugins: () => [
        ghost('broken', { liveScreen: true, node }),
        ghost('sim', { liveScreen: true, node }),
      ],
      request,
      locale: () => 'en',
    });
    expect((await h.list()).map((s) => s.plugin)).toEqual(['sim']);
  });

  it('opens only a loopback frame stream with a valid descriptor and maps refusals to stable codes', async () => {
    const node = { entry: 'worker.cjs', protocol: 'json-rpc-stdio' };
    let result: unknown;
    const { host: h } = host([ghost('sim', { liveScreen: true, node })], () => result);
    const screen = {
      platform: 'ios',
      width: 1179,
      height: 2556,
      cornerRadius: 0.9,
      maxTouches: 99,
      keyboard: true,
      buttons: [
        { id: 'home', icon: 'home', label: '主屏幕' },
        { id: 'home', icon: 'home', label: 'duplicate' },
        { id: 'BAD', icon: 'home', label: 'x' },
        { id: 'x', icon: 'rocket', label: 'x' },
      ],
    };
    result = { ok: true, url: 'http://127.0.0.1:41234/live-screen/abc', screen };
    expect(await h.open('sim', 'UDID-1')).toEqual({
      url: 'http://127.0.0.1:41234/live-screen/abc',
      screen: {
        ...screen,
        cornerRadius: 0.5,
        maxTouches: 10,
        buttons: [{ id: 'home', icon: 'home', label: '主屏幕' }],
      },
    });
    for (const url of [
      'http://localhost:41234/x',
      'https://127.0.0.1:41234/x',
      'http://127.0.0.1/x',
      'http://a:b@127.0.0.1:41234/x',
      'http://10.0.0.2:41234/x',
    ]) {
      result = { ok: true, url, screen };
      await expect(h.open('sim', 'UDID-1')).rejects.toThrow('DESKTOP_SCREEN_FAILED');
    }
    result = { ok: false, errorCode: 'NOT_RUNNING', message: 'off' };
    await expect(h.open('sim', 'UDID-1')).rejects.toThrow('DESKTOP_SCREEN_NOT_RUNNING');
    result = { ok: false, errorCode: 'SOMETHING_ELSE' };
    await expect(h.open('sim', 'UDID-1')).rejects.toThrow('DESKTOP_SCREEN_FAILED');
    await expect(h.open('other', 'UDID-1')).rejects.toThrow('DESKTOP_SCREEN_UNAVAILABLE');
  });

  it('validates descriptors and frame URLs on their own', () => {
    expect(parseLiveScreenDescriptor({ platform: 'ios', width: 8, height: 100 })).toBeNull();
    expect(
      parseLiveScreenDescriptor({ platform: 'android', width: 1080, height: 2400 }),
    ).toMatchObject({
      cornerRadius: 0,
      maxTouches: 0,
      keyboard: false,
      buttons: [],
    });
    expect(isLiveScreenFrameUrl('http://127.0.0.1:65535/a')).toBe(true);
    expect(isLiveScreenFrameUrl('http://127.0.0.1:80/a')).toBe(false);
    expect(isLiveScreenFrameUrl('http://127.0.0.1:41234/a#x')).toBe(false);
  });
});
