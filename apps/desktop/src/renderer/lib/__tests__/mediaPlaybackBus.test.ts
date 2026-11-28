// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetMediaBusForTests, registerMedia } from '../mediaPlaybackBus';

describe('mediaPlaybackBus', () => {
  beforeEach(() => {
    __resetMediaBusForTests();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  });

  afterEach(() => {
    __resetMediaBusForTests();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it('pauses a mounted element and keeps its source for a replayed effect', () => {
    const el = document.createElement('video');
    el.setAttribute('src', '/asset.mp4');
    document.body.append(el);

    registerMedia(el)();

    expect(el.pause).toHaveBeenCalled();
    expect(el.getAttribute('src')).toBe('/asset.mp4');
    expect(el.load).not.toHaveBeenCalled();
  });

  it('releases a detached element that the bus can no longer reach', () => {
    const el = document.createElement('video');
    el.setAttribute('src', '/asset.mp4');
    const source = document.createElement('source');
    source.setAttribute('src', '/asset.webm');
    el.append(source);
    document.body.append(el);

    const unregister = registerMedia(el);
    el.remove();
    unregister();

    expect(el.pause).toHaveBeenCalled();
    expect(el.getAttribute('src')).toBeNull();
    expect(source.getAttribute('src')).toBeNull();
    expect(el.srcObject).toBeNull();
    expect(el.load).toHaveBeenCalledTimes(1);
  });
});
