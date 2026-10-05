// @vitest-environment jsdom
import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MermaidDiagramWebView, type MermaidDiagramWebViewHandle } from '@/session/mermaidWebView';
import { MathFormulaWebView } from '@/session/mathWebView';
import { RichContentContext } from '@/session/richContentContext';
import { RichContentRuntime } from '@/session/richContentRuntime';

const state = vi.hoisted(() => ({
  props: {} as any, image: null as any, layout: null as any, mounts: 0, live: 0, imageLive: 0, height: 0,
  dark: false, inject: vi.fn(),
}));
vi.mock('react-native', async () => {
  const { useEffect } = await import('react');
  return {
    View: (props: any) => {
      if (props.onLayout) state.layout = props.onLayout;
      state.height = props.style?.find((style: any) => typeof style?.height === 'number')?.height;
      return props.children;
    },
    Image: (props: any) => {
      state.image = props;
      useEffect(() => { state.imageLive++; return () => { state.imageLive--; }; }, []);
      return null;
    },
    StyleSheet: { create: (v: unknown) => v, hairlineWidth: 1 },
  };
});
vi.mock('react-native-webview', async () => {
  const { forwardRef, useEffect, useImperativeHandle } = await import('react');
  return { WebView: forwardRef((props: any, ref) => {
    state.props = props;
    useImperativeHandle(ref, () => ({ injectJavaScript: state.inject }));
    useEffect(() => { state.mounts++; state.live++; return () => { state.live--; }; }, []);
    return null;
  }) };
});
vi.mock('expo-file-system', () => ({ Directory: class {}, File: class {}, Paths: {} }));
vi.mock('@/theme', () => ({
  useThemedStyles: () => ({}),
  useTheme: () => ({ mode: state.dark ? 'dark' : 'light', colors: {
    surface: state.dark ? '#111111' : '#ffffff', surfaceChip: state.dark ? '#222222' : '#eeeeee',
    textPrimary: state.dark ? '#ffffff' : '#111111', textSecondary: '#555555', textTertiary: '#666666',
  } }),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let runtime: RichContentRuntime;
const png = 'iVBORw0KGgo' + 'A'.repeat(30);
function render(kind: 'mermaid' | 'math', source: string, active = true) {
  act(() => root.render(createElement(RichContentContext.Provider, { value: runtime },
    kind === 'mermaid'
      ? createElement(MermaidDiagramWebView, { source, active, cachePreview: true })
      : createElement(MathFormulaWebView, { source, active }))));
  act(() => state.layout({ nativeEvent: { layout: { width: 360 } } }));
}
function tick(ms = 200) { act(() => vi.advanceTimersByTime(ms)); }
function message(props: any, payload: unknown) { act(() => props.onMessage({ nativeEvent: { data: JSON.stringify(payload) } })); }
beforeEach(() => {
  vi.useFakeTimers(); runtime = new RichContentRuntime();
  state.mounts = 0; state.live = 0; state.imageLive = 0; state.image = null; state.layout = null; state.dark = false;
  root = createRoot(document.createElement('div'));
});
afterEach(() => { act(() => root.unmount()); runtime.clear(); vi.useRealTimers(); });

it('cancels unseen work, keeps visible content during a drag and reuses a snapshot on revisit', () => {
  runtime.onScroll(); render('mermaid', 'graph TD; A-->B'); tick(100);
  expect(state.mounts).toBe(0);
  render('mermaid', 'graph TD; A-->B', false); tick(); expect(state.mounts).toBe(0);
  render('mermaid', 'graph TD; A-->B'); tick(); expect(state.live).toBe(1);
  runtime.onScroll(); tick(100); expect(state.live).toBe(1);
  message(state.props, { type: 'mermaid-export', id: 'inline-preview', ok: true, base64: png });
  expect(state.live).toBe(0); expect(state.image.source.uri).toContain(png);
  act(() => root.render(null));
  render('mermaid', 'graph TD; A-->B'); tick(); expect(state.mounts).toBe(1);
  const previous = runtime; runtime = new RichContentRuntime(); previous.clear();
  render('mermaid', 'graph TD; A-->B'); tick(); expect(state.mounts).toBe(2);
});

it.each([false, true])('unmounts offscreen snapshots and revisits them without a WebView (dark=%s)', (dark) => {
  state.dark = dark;
  const source = 'graph TD; Hidden-->Visible';
  render('mermaid', source); tick();
  message(state.props, { type: 'mermaid-export', id: 'inline-preview', ok: true, base64: png });
  expect(state.imageLive).toBe(1);
  expect(state.height).toBe(220);
  const uri = state.image.source.uri;
  render('mermaid', source, false); tick();
  expect(state.imageLive).toBe(0);
  expect(state.live).toBe(0);
  expect(state.height).toBe(220);
  runtime.onScroll();
  render('mermaid', source);
  expect(state.imageLive).toBe(1);
  expect(state.image.source.uri).toBe(uri);
  tick();
  expect(state.mounts).toBe(1);
});

it.each([false, true])('isolates formula heights by width and ignores old document reports (dark=%s)', (dark) => {
  state.dark = dark;
  const source = `width-sensitive-${dark}`;
  render('math', source); tick();
  const narrow = state.props;
  message(narrow, { kind: 'math-height', stage: 'katex', height: 140 });
  expect(state.height).toBe(140);
  act(() => state.layout({ nativeEvent: { layout: { width: 480 } } }));
  expect(state.height).toBe(60);
  tick();
  message(narrow, { kind: 'math-height', stage: 'katex', height: 200 });
  expect(state.height).toBe(60);
  // The previous width's final height must not suppress the new document's source height.
  message(state.props, { kind: 'math-height', stage: 'source', height: 90 });
  expect(state.height).toBe(90);
  message(state.props, { kind: 'math-height', stage: 'katex', height: 80 });
  expect(state.height).toBe(80);
  act(() => state.layout({ nativeEvent: { layout: { width: 360 } } }));
  expect(state.height).toBe(140);
  tick();
  message(state.props, { kind: 'math-height', stage: 'source', height: 70 });
  expect(state.height).toBe(140);
  act(() => state.layout({ nativeEvent: { layout: { width: 480 } } }));
  expect(state.height).toBe(80);
  act(() => root.render(null));
  render('math', source);
  expect(state.height).toBe(140);
});

it('ignores stale snapshots and invalidates content, theme and width independently', () => {
  render('mermaid', 'graph TD; A-->B'); tick(); const old = state.props;
  render('mermaid', 'graph TD; A-->C'); tick();
  message(old, { type: 'mermaid-export', id: 'inline-preview', ok: true, base64: png });
  expect(state.image).toBeNull(); expect(state.live).toBe(1);
  message(state.props, { type: 'mermaid-export', id: 'inline-preview', ok: true, base64: png });
  expect(state.live).toBe(0);
  state.dark = true; render('mermaid', 'graph TD; A-->C'); tick(); expect(state.live).toBe(1);
  message(state.props, { type: 'mermaid-export', id: 'inline-preview', ok: true, base64: png });
  act(() => state.layout({ nativeEvent: { layout: { width: 480 } } }));
  tick(); expect(state.live).toBe(1);
});

it('keeps the live view when snapshots fail or exceed the cache budget, and falls back on image decode failure', () => {
  render('mermaid', 'graph TD; A-->B'); tick();
  message(state.props, { type: 'mermaid-export', id: 'inline-preview', ok: false });
  expect(state.live).toBe(1);
  message(state.props, { type: 'mermaid-export', id: 'inline-preview', ok: true, base64: png + 'A'.repeat(1024 * 1024) });
  expect(state.live).toBe(1);
  message(state.props, { type: 'mermaid-export', id: 'inline-preview', ok: true, base64: png });
  act(() => state.image.onError()); tick(); expect(state.live).toBe(1);
  expect(state.props.source.html).toContain('if (!false) return;');
});

it('keeps immediate formula mounting and measured height reuse without the Android runtime', () => {
  const formula = () => createElement(MathFormulaWebView, { source: 'non-android-formula' });
  act(() => root.render(formula()));
  expect(state.layout).toBeNull();
  expect(state.live).toBe(1);
  message(state.props, { kind: 'math-height', stage: 'katex', height: 112 });
  state.dark = true;
  act(() => root.render(formula()));
  expect(state.live).toBe(1);
  expect(state.height).toBe(112);
  act(() => root.render(null));
  act(() => root.render(formula()));
  expect(state.live).toBe(1);
  expect(state.height).toBe(112);
});

it('reuses formula markup without restarting the current document and rejects late results from another source', () => {
  render('math', 'x^2'); tick(); const old = state.props;
  message(old, { kind: 'math-rendered', markup: '<span class="katex">squared</span>' });
  expect(state.props.source.html).toBe(old.source.html);
  render('math', 'x^3'); tick();
  message(old, { kind: 'math-rendered', markup: '<span>wrong</span>' });
  render('math', 'x^2', false); render('math', 'x^2'); tick();
  expect(state.props.source.html).toContain('squared');
  expect(state.props.source.html).not.toContain('script.textContent =');
  expect(state.props.source.html).toContain('overflow-x: auto');
  expect(state.props.source.html).not.toContain('wrong');
});

it('keeps full-screen diagrams live and exports through the original request/response handle', async () => {
  const ref = createRef<MermaidDiagramWebViewHandle>();
  act(() => root.render(createElement(RichContentContext.Provider, { value: runtime },
    createElement(MermaidDiagramWebView, { source: 'graph TD; A-->B', fill: true, zoomable: true, ref }))));
  expect(state.live).toBe(1);
  const result = ref.current!.exportPng();
  expect(state.inject).toHaveBeenCalled();
  message(state.props, { type: 'mermaid-export', id: 'export-1', ok: true, base64: png });
  await expect(result).resolves.toBe(png);
  expect(state.live).toBe(1);
});
