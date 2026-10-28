// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en' },
  }),
}));

const getModel3DThumbnail = vi.fn();
vi.mock('@/lib/model3d/thumbnails', () => ({
  getModel3DThumbnail: (...args: unknown[]) => getModel3DThumbnail(...args),
}));

vi.mock('../components/chat/ModelLightbox', () => ({
  ModelLightbox: ({ source }: { source: unknown }) =>
    React.createElement('div', { 'data-testid': 'model-lightbox', 'data-source': JSON.stringify(source) }),
}));

import { Model3DCard, Model3DCardContent } from '../components/chat/Model3DCard';

/** Controllable IntersectionObserver: nothing is visible until `reveal()` is called. */
let observers: Array<{ cb: IntersectionObserverCallback; el: Element | null; disconnected: boolean }> = [];
class FakeIntersectionObserver {
  private record: { cb: IntersectionObserverCallback; el: Element | null; disconnected: boolean };
  constructor(cb: IntersectionObserverCallback) {
    this.record = { cb, el: null, disconnected: false };
    observers.push(this.record);
  }
  observe(el: Element) { this.record.el = el; }
  disconnect() { this.record.disconnected = true; }
  unobserve() {}
  takeRecords() { return []; }
}
const reveal = () => act(() => {
  for (const o of observers) {
    if (!o.disconnected && o.el) o.cb([{ isIntersecting: true, target: o.el } as IntersectionObserverEntry], {} as IntersectionObserver);
  }
});

const HASH = 'c'.repeat(64);
const blobSource = { kind: 'blob' as const, url: `cindy-media://blobs/${HASH}.glb` };
const localSource = { kind: 'local' as const, absPath: '/work/ship.fbx' };

beforeEach(() => {
  observers = [];
  getModel3DThumbnail.mockReset().mockResolvedValue('data:image/png;base64,AAAA');
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Model3DCardContent', () => {
  it('does not read or render the model until the card scrolls into view', async () => {
    render(React.createElement(Model3DCardContent, { source: localSource }));
    expect(getModel3DThumbnail).not.toHaveBeenCalled();
    reveal();
    await waitFor(() => expect(getModel3DThumbnail).toHaveBeenCalledWith(localSource));
    const img = await screen.findByAltText('chat.media.modelPreviewAlt');
    expect(img.getAttribute('src')).toBe('data:image/png;base64,AAAA');
  });

  it('shows only the upper-cased format tag on the thumbnail, not the file name', () => {
    render(React.createElement(Model3DCardContent, { source: localSource }));
    expect(screen.getByText('FBX')).toBeTruthy();
    expect(screen.queryByText('ship.fbx')).toBeNull();
  });

  it('derives the format tag from the explicit file name for a managed GLB', () => {
    render(React.createElement(Model3DCardContent, { source: blobSource, fileName: 'chair.glb' }));
    expect(screen.getByText('GLB')).toBeTruthy();
    expect(screen.queryByText('chair.glb')).toBeNull();
  });

  it('exposes the file name as the card tooltip', () => {
    render(React.createElement(Model3DCard, { source: localSource }));
    expect(screen.getByTitle('ship.fbx')).toBeTruthy();
  });

  it('falls back to a placeholder (no image, no crash) when the thumbnail fails', async () => {
    getModel3DThumbnail.mockRejectedValue(new Error('too large'));
    render(React.createElement(Model3DCardContent, { source: localSource }));
    reveal();
    await waitFor(() => expect(getModel3DThumbnail).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByAltText('chat.media.modelPreviewAlt')).toBeNull();
    expect(screen.getByText('ship.fbx')).toBeTruthy();
    // 退化成一行「图标 + 名字 + 格式」,不再留 1:1 的空方块
    expect(screen.getByText('FBX')).toBeTruthy();
    expect(document.querySelector('.aspect-square')).toBeNull();
  });

  it('keeps the square thumbnail frame while loading', async () => {
    getModel3DThumbnail.mockReturnValue(new Promise(() => {}));
    render(React.createElement(Model3DCardContent, { source: localSource }));
    reveal();
    await waitFor(() => expect(getModel3DThumbnail).toHaveBeenCalled());
    expect(document.querySelector('.aspect-square')).not.toBeNull();
  });

  it('stays idle while disabled (e.g. the file is still pending review)', async () => {
    render(React.createElement(Model3DCardContent, { source: localSource, enabled: false }));
    reveal();
    await act(async () => { await Promise.resolve(); });
    expect(getModel3DThumbnail).not.toHaveBeenCalled();
  });

  it('requests the thumbnail only once for the same source', async () => {
    const { rerender } = render(React.createElement(Model3DCardContent, { source: { ...localSource } }));
    reveal();
    await waitFor(() => expect(getModel3DThumbnail).toHaveBeenCalledTimes(1));
    rerender(React.createElement(Model3DCardContent, { source: { ...localSource } }));
    await act(async () => { await Promise.resolve(); });
    expect(getModel3DThumbnail).toHaveBeenCalledTimes(1);
  });
});

describe('Model3DCard', () => {
  it('opens the 3D viewer for the managed GLB on click', () => {
    render(React.createElement(Model3DCard, { source: blobSource }));
    expect(screen.queryByTestId('model-lightbox')).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    const lightbox = screen.getByTestId('model-lightbox');
    expect(JSON.parse(lightbox.getAttribute('data-source')!)).toEqual({ kind: 'blob', url: blobSource.url });
  });

  it('opens the viewer for a local model of any format', () => {
    render(React.createElement(Model3DCard, { source: localSource }));
    fireEvent.click(screen.getByRole('button'));
    const lightbox = screen.getByTestId('model-lightbox');
    expect(JSON.parse(lightbox.getAttribute('data-source')!)).toEqual({ kind: 'local', absPath: '/work/ship.fbx' });
  });
});
