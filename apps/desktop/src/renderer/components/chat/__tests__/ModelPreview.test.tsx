// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  parse: vi.fn(), disposeObject: vi.fn(), disposeEngine: vi.fn(), fetch: vi.fn(),
}));
vi.mock('../loadPreviewModel', () => ({ loadPreviewModel: mocks.parse }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../PreviewChrome', () => ({
  PreviewFooter: ({ children }: { children: React.ReactNode }) => <footer>{children}</footer>,
  PreviewButton: ({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) => <button disabled={disabled} onClick={onClick}>{label}</button>,
}));
vi.mock('mivo-model-viewer/core', () => ({
  setEnabledFormats: vi.fn(),
  disposeObject3D: mocks.disposeObject,
  ViewerEngine: class {
    setRenderSize = vi.fn();
    addObject = vi.fn();
    removeObject = vi.fn();
    setCamera = vi.fn();
    focusObject = vi.fn();
    dispose = mocks.disposeEngine;
  },
}));
import { ModelPreview } from '../ModelPreview';

/** Test value: closing or switching ordinary file preview while parsing must
 * release WebGL/resources and ignore late results; a failed file can retry.
 * No existing component test covers this new async parser lifecycle. Minimal
 * input is a deferred parser resolved after unmount. Unit tier with no WebGL. */
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  mocks.fetch.mockResolvedValue({ ok: true, blob: async () => new Blob(['model']) });
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ModelPreview', () => {
  it('disposes late parsed objects after the file preview closes', async () => {
    let resolve!: (value: { animations: [] }) => void;
    mocks.parse.mockReturnValue(new Promise(value => { resolve = value; }));
    const view = render(<ModelPreview url="cindy-media://blobs/example.glb" filename="example.glb" />);
    await act(async () => { await Promise.resolve(); });
    expect(mocks.parse).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toContain('chat.media.modelLoading');
    view.unmount();
    expect(mocks.disposeEngine).toHaveBeenCalledTimes(1);
    const object = { animations: [] as [] };
    await act(async () => { resolve(object); });
    expect(mocks.disposeObject).toHaveBeenCalledWith(object);
    expect(mocks.fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('retries a failed preview using the same authorized local path', async () => {
    mocks.parse.mockRejectedValueOnce(new Error('Invalid model')).mockResolvedValueOnce({ animations: [] });
    const readFileBytes = vi.fn().mockResolvedValue({ bytes: new Uint8Array([1]), size: 1 });
    vi.stubGlobal('window', Object.assign(window, { electronAPI: { readFileBytes } }));
    const view = render(<ModelPreview url="xdt-file:///authorized/model.obj" path="/authorized/model.obj" filename="model.obj" />);
    expect((await screen.findByRole('alert')).textContent).toContain('chat.media.modelLoadFailed');
    fireEvent.click(screen.getByRole('button', { name: 'attachmentPreview.retry' }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(readFileBytes.mock.calls.map(call => call[0].filePath)).toEqual(['/authorized/model.obj', '/authorized/model.obj']);
    expect(mocks.fetch).not.toHaveBeenCalled();
    view.unmount();
    expect(mocks.disposeObject).toHaveBeenCalledTimes(1);
    expect(mocks.disposeEngine).toHaveBeenCalledTimes(2);
  });
});
