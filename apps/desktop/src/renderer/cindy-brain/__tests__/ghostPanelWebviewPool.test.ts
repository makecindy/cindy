// @vitest-environment jsdom
/**
 * ghostPanelWebviewPool —— 常驻池生命周期单测。
 * jsdom 下 <webview> 是普通 HTMLElement,只断言 DOM 归属 / 指纹重建 / 释放 /
 * 崩溃广播,不测真 webContents(browserWebviewPool.test.ts 同口径)。
 * 主题注入依赖 webview.executeJavaScript 等真 Electron 面,整体 mock 掉。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../ghostPanelTheme', () => ({
  createGhostThemeInjector: vi.fn(() => ({
    inject: vi.fn(),
    onDomReady: vi.fn(),
    dispose: vi.fn(),
  })),
  observeHostTheme: vi.fn(() => () => undefined),
}));

import type { GhostManifest } from '../../../shared/ghost';
import {
  GHOST_PANEL_POOL_CONTAINER_ID,
  ghostPanelFingerprint,
  ghostPanelWebviewPool,
} from '../ghostPanelWebviewPool';

function makeManifest(overrides: Partial<GhostManifest> = {}): GhostManifest {
  return {
    id: 'cindy-art',
    name: 'Cindy Art',
    version: '1.0.0',
    panel: { html: 'panel.html', position: 'tab' },
    ...overrides,
  } as GhostManifest;
}

describe('ghostPanelWebviewPool', () => {
  beforeEach(() => {
    ghostPanelWebviewPool.releaseAll();
  });
  afterEach(() => {
    ghostPanelWebviewPool.releaseAll();
  });

  it('acquire 创建 wrapper + webview(partition / src 与停靠形态同源)并停进停车区', () => {
    const entry = ghostPanelWebviewPool.acquire(makeManifest());
    expect(entry).not.toBeNull();
    expect(entry!.webview.getAttribute('partition')).toBe('cindy-ghost-cindy-art');
    expect(entry!.webview.getAttribute('src')).toBe('cindy-ghost://cindy-art/panel.html');
    const parking = document.getElementById(GHOST_PANEL_POOL_CONTAINER_ID);
    expect(parking).not.toBeNull();
    expect(entry!.wrapper.parentElement).toBe(parking);
  });

  it('同指纹 acquire 返回同一 entry(webview 不重建)', () => {
    const manifest = makeManifest();
    const a = ghostPanelWebviewPool.acquire(manifest);
    const b = ghostPanelWebviewPool.acquire(makeManifest());
    expect(b).toBe(a);
  });

  it('指纹变化(原位升级)→ 释放旧 entry 重建', () => {
    const a = ghostPanelWebviewPool.acquire(makeManifest());
    const b = ghostPanelWebviewPool.acquire(makeManifest({ version: '2.0.0' }));
    expect(b).not.toBe(a);
    expect(a!.wrapper.isConnected).toBe(false);
    expect(b!.wrapper.isConnected).toBe(true);
  });

  it('无 panel.html 的清单返回 null', () => {
    expect(ghostPanelWebviewPool.acquire(makeManifest({ panel: undefined }))).toBeNull();
  });

  it('release:wrapper 移出 DOM,peek 变 null', () => {
    ghostPanelWebviewPool.acquire(makeManifest());
    const entry = ghostPanelWebviewPool.peek('cindy-art');
    ghostPanelWebviewPool.release('cindy-art');
    expect(ghostPanelWebviewPool.peek('cindy-art')).toBeNull();
    expect(entry!.wrapper.isConnected).toBe(false);
  });

  it('sync:不在存活清单或指纹已变的 entry 释放,匹配的保留', () => {
    const keep = makeManifest();
    const stale = makeManifest({ id: 'cindy-mermaid' });
    const gone = makeManifest({ id: 'cindy-web-search' });
    ghostPanelWebviewPool.acquire(keep);
    ghostPanelWebviewPool.acquire(stale);
    ghostPanelWebviewPool.acquire(gone);
    ghostPanelWebviewPool.sync([
      { ghostId: 'cindy-art', fingerprint: ghostPanelFingerprint(keep) },
      {
        ghostId: 'cindy-mermaid',
        fingerprint: ghostPanelFingerprint(makeManifest({ id: 'cindy-mermaid', version: '9.9.9' })),
      },
    ]);
    expect(ghostPanelWebviewPool.inspectGhostIds()).toEqual(['cindy-art']);
  });

  it('render-process-gone → entry.crashed + onCrash 广播;释放后不再广播', () => {
    const crashes: string[] = [];
    const off = ghostPanelWebviewPool.onCrash((id) => crashes.push(id));
    const entry = ghostPanelWebviewPool.acquire(makeManifest());
    entry!.webview.dispatchEvent(new Event('render-process-gone'));
    expect(entry!.crashed).toBe(true);
    expect(crashes).toEqual(['cindy-art']);
    // 重复事件不重复广播
    entry!.webview.dispatchEvent(new Event('render-process-gone'));
    expect(crashes).toEqual(['cindy-art']);
    // release 之后事件不再进入池
    ghostPanelWebviewPool.release('cindy-art');
    entry!.webview.dispatchEvent(new Event('render-process-gone'));
    expect(crashes).toEqual(['cindy-art']);
    off();
  });

  it('releaseAll 清空全部 entry', () => {
    ghostPanelWebviewPool.acquire(makeManifest());
    ghostPanelWebviewPool.acquire(makeManifest({ id: 'cindy-mermaid' }));
    ghostPanelWebviewPool.releaseAll();
    expect(ghostPanelWebviewPool.inspectGhostIds()).toEqual([]);
  });
});
