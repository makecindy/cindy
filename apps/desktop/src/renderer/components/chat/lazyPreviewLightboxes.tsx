/**
 * 文本／Mermaid 预览弹窗的按需加载入口。
 *
 * 两个弹窗都依赖 CodeMirror 编辑器与全部语言语法、highlight.js（生产构建约 1.7 MB），
 * 只在用户点开文件或图表时才用到。聊天消息、附件、工具卡片从这里引用它们，主窗口首屏
 * 不再静态加载这些分包。调用方都是「打开时才挂载」，分包加载期间不渲染任何内容；
 * 主窗口首帧稳定后在空闲时预取（见 schedulePreviewLightboxPreload），首次点开仍是热的。
 */
import { lazy, Suspense, type ComponentProps } from 'react';
import type { TextLightbox as TextLightboxImpl } from './TextLightbox';
import type { MermaidLightbox as MermaidLightboxImpl } from './MermaidLightbox';

const loadTextLightbox = () => import('./TextLightbox');
const loadMermaidLightbox = () => import('./MermaidLightbox');

const LazyTextLightbox = lazy(() =>
  loadTextLightbox().then((module) => ({ default: module.TextLightbox })),
);
const LazyMermaidLightbox = lazy(() =>
  loadMermaidLightbox().then((module) => ({ default: module.MermaidLightbox })),
);

export function TextLightbox(props: ComponentProps<typeof TextLightboxImpl>) {
  return (
    <Suspense fallback={null}>
      <LazyTextLightbox {...props} />
    </Suspense>
  );
}

export function MermaidLightbox(props: ComponentProps<typeof MermaidLightboxImpl>) {
  return (
    <Suspense fallback={null}>
      <LazyMermaidLightbox {...props} />
    </Suspense>
  );
}

const PRELOAD_DELAY_MS = 3_000;
const PRELOAD_IDLE_TIMEOUT_MS = 5_000;

/**
 * 主窗口可见且首帧稳定后，在空闲时预取两个弹窗分包，让首次点开不必等加载。
 * 隐藏启动的窗口等到可见再开始计时。返回取消函数。
 */
export function schedulePreviewLightboxPreload(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let idleId: number | null = null;
  const preload = () => {
    idleId = null;
    void loadTextLightbox().catch(() => undefined);
    void loadMermaidLightbox().catch(() => undefined);
  };
  const start = () => {
    if (document.visibilityState !== 'visible') return;
    document.removeEventListener('visibilitychange', start);
    timer = setTimeout(() => {
      timer = null;
      if (typeof window.requestIdleCallback === 'function') {
        idleId = window.requestIdleCallback(preload, { timeout: PRELOAD_IDLE_TIMEOUT_MS });
      } else {
        preload();
      }
    }, PRELOAD_DELAY_MS);
  };
  document.addEventListener('visibilitychange', start);
  start();
  return () => {
    document.removeEventListener('visibilitychange', start);
    if (timer !== null) clearTimeout(timer);
    if (idleId !== null) window.cancelIdleCallback(idleId);
  };
}
