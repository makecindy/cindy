// @vitest-environment jsdom
// Unit: review #10636, duplicate manual-image downloads and stale account/device results.
// Existing host tests do not mount icon consumers. Two simultaneous icons and one owner switch
// are the minimal regression; only transport and native presentation are replaced.
import React, { act } from 'react';
import { renderToString } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ owner: { id: 'a' }, read: vi.fn() }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => h.owner,
  isDataOwnerGenerationCurrent: (owner: unknown) => owner === h.owner,
}));
import { ProjectIcon } from '../ProjectIcon';
it('shares image downloads and never displays bytes belonging to the previous owner or device', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(window, { electronAPI: { deviceLink: { invoke: h.read } } });
  const element = document.createElement('div');
  const root = createRoot(element);
  const icon = `cindy-media://blobs/${'a'.repeat(64)}.png`;
  const image = 'data:image/png;base64,YQ==';
  const props = { value: icon, projectKey: 'local:/repo', projectName: 'Repo', deviceId: 'pc' };
  const render = async (overrides = {}) =>
    act(async () => {
      root.render(
        <>
          <ProjectIcon {...props} {...overrides} />
          <ProjectIcon {...props} {...overrides} />
        </>,
      );
    });
  try {
    h.read.mockResolvedValue(image);
    await render();
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(element.querySelectorAll('img')).toHaveLength(2);
    let resolve!: (data: string) => void;
    h.read.mockImplementation(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    // A remount must paint the image before effects, including during a slow refresh.
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    try {
      expect(renderToString(<ProjectIcon {...props} />)).toContain(image);
      await act(async () => root.render(null));
      await render();
      expect(element.querySelectorAll('img')).toHaveLength(2);
      expect(h.read).toHaveBeenCalledTimes(2);
      await act(async () => resolve(image));
    } finally {
      now.mockRestore();
    }
    h.owner = { id: 'b' };
    await render();
    expect(element.querySelector('img')).toBeNull();
    expect(h.read).toHaveBeenCalledTimes(3);
    const previousDevice = resolve;
    await render({ deviceId: 'other' });
    const settle = resolve;
    await act(async () => previousDevice(image));
    expect(element.querySelector('img')).toBeNull();
    expect(h.read).toHaveBeenCalledTimes(4);
    await act(async () => settle(image));
    expect(element.querySelectorAll('img')).toHaveLength(2);
    await render({ value: `cindy-media://blobs/${'b'.repeat(64)}.png`, deviceId: 'other' });
    expect(element.querySelector('img')).toBeNull();
    expect(h.read).toHaveBeenCalledTimes(5);
  } finally {
    await act(async () => root.unmount());
  }
});

// Unit: an expired image remains during refresh, but authoritative empty/error must remove it.
// Mount two real icons; no network, timers, or native image decoder required.
it.each(['empty', 'denied'] as const)('removes cached images after a %s refresh', async (result) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(window, { electronAPI: { deviceLink: { invoke: h.read } } });
  h.owner = { id: result };
  h.read.mockResolvedValue('data:image/png;base64,YQ==');
  const element = document.createElement('div');
  const root = createRoot(element);
  const props = { value: `cindy-media://blobs/${'c'.repeat(64)}.png`, projectKey: '/repo', projectName: 'Repo', deviceId: 'pc' };
  const render = () => root.render(<><ProjectIcon {...props} /><ProjectIcon {...props} /></>);
  const now = vi.spyOn(Date, 'now');
  try {
    await act(async () => render());
    expect(element.querySelectorAll('img')).toHaveLength(2);
    await act(async () => root.render(null));
    now.mockReturnValue(Date.now() + 61_000);
    let finish!: () => void;
    h.read.mockImplementation(() => new Promise((resolve, reject) => {
      finish = () => result === 'empty' ? resolve(null) : reject(new Error('PERMISSION_DENIED'));
    }));
    await act(async () => render());
    expect(element.querySelectorAll('img')).toHaveLength(2);
    await act(async () => finish());
    expect(element.querySelectorAll('img')).toHaveLength(0);
    expect(element.querySelectorAll('[data-project-monogram]')).toHaveLength(2);
  } finally {
    now.mockRestore();
    await act(async () => root.unmount());
  }
});
