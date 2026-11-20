// @vitest-environment jsdom
// 测试价值
// - 生产入口与可观察结果：registerMedia 的清理函数；播放中的元素会停下，脱离页面的元素会丢掉源。
// - Bug／规则依据：#11715。注销后 stopAllMedia 找不到播放器，Chromium 会继续出声。
// - 现有覆盖缺口：ChatVideoView 只断言预览关闭时的 pause/load，不覆盖总线注销本身。
// - 最小失败输入：一个 paused=false 且未挂载的 audio，调用 registerMedia 返回的清理函数。
// - tier：unit。jsdom 看不到真实音频时钟；Chromium 对照见 PR 验证记录。
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerMedia, stopAllMedia, __resetMediaBusForTests } from '../mediaPlaybackBus';

function audio(src = '/tone.wav'): HTMLAudioElement {
  const el = document.createElement('audio');
  el.setAttribute('src', src);
  let paused = false;
  Object.defineProperty(el, 'paused', { configurable: true, get: () => paused });
  vi.spyOn(el, 'pause').mockImplementation(() => {
    paused = true;
  });
  vi.spyOn(el, 'load').mockImplementation(() => {});
  return el;
}

afterEach(() => {
  document.body.replaceChildren();
  __resetMediaBusForTests();
  vi.restoreAllMocks();
});

describe('registerMedia cleanup (#11715)', () => {
  it('pauses a playing element before the bus forgets it', () => {
    const el = audio();
    const unregister = registerMedia(el);
    unregister();
    expect(el.pause).toHaveBeenCalledOnce();
    vi.mocked(el.pause).mockClear();
    Object.defineProperty(el, 'paused', { configurable: true, get: () => false });
    stopAllMedia();
    expect(el.pause).not.toHaveBeenCalled();
  });

  it('releases a detached element and keeps a mounted element reusable', () => {
    const detached = audio('/detached.wav');
    const nested = document.createElement('source');
    nested.setAttribute('src', '/nested.wav');
    detached.append(nested);
    registerMedia(detached)();
    expect(detached.getAttribute('src')).toBeNull();
    expect(nested.getAttribute('src')).toBeNull();
    expect(detached.load).toHaveBeenCalledOnce();

    const mounted = audio('/mounted.wav');
    document.body.append(mounted);
    registerMedia(mounted)();
    expect(mounted.pause).toHaveBeenCalledOnce();
    expect(mounted.getAttribute('src')).toBe('/mounted.wav');
    expect(mounted.load).not.toHaveBeenCalled();
  });
});
