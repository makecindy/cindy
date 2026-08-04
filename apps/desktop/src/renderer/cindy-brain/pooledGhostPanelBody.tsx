import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ContextMenuEvent } from 'electron';

import { isGhostTabPinned } from '@/features/right-sidebar/lib/pinnedGhostTabs';
import type { GhostManifest } from '../../shared/ghost';
import {
  GhostPanelError,
  GhostPanelMediaMenu,
  pickGhostPanelMediaUri,
  type GhostPanelMediaMenuState,
} from './ghostPanelBody';
import {
  GHOST_PANEL_POOL_CONTAINER_ID,
  ghostPanelWebviewPool,
} from './ghostPanelWebviewPool';

/**
 * PooledGhostPanelBody —— 面板页签形态的面板体,webview 托管在
 * ghostPanelWebviewPool(常驻池),React 只负责把 wrapper 搬进 / 搬出自己的 slot。
 *
 * 与 GhostChipPanelBody(每次挂载新建 webview,停靠形态继续用)的分工:
 *  - 页签形态统一走本组件:挂载时收养池里的 wrapper,卸载时把 wrapper 停回
 *    停车区(钉住 → webview 保活,跨会话状态不丢)或释放(未钉住 → 维持
 *    "仅当前会话"的既有语义,不白占内存);
 *  - 懒物化:面板页签**首次可见**才创建 webview —— 钉住多个插件不会在启动 /
 *    切会话时把所有面板一起拉起;
 *  - 崩溃接管:池层广播 render-process-gone,本组件切 GhostPanelError,
 *    「重载」= release + 重新 acquire(原地重挂载,不经主机)。
 *
 * 媒体右键菜单挂在"正在收养 wrapper 的 body"上(webview 事件监听随收养期
 * 增删):菜单坐标 / 浮层都属于当前宿主视图,停车区里的面板没有可弹的宿主。
 */
export function PooledGhostPanelBody({
  manifest,
  visible,
}: {
  manifest: GhostManifest;
  /** 页签当前是否真的可见(active 且侧栏展开)。懒物化判据。 */
  visible: boolean;
}): ReactNode {
  const [crashed, setCrashed] = useState(
    () => ghostPanelWebviewPool.peek(manifest.id)?.crashed === true,
  );
  // 崩溃重载计数:release 后靠它驱动 effect 重跑重新 acquire。
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const [mediaMenu, setMediaMenu] = useState<GhostPanelMediaMenuState | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);

  // 池层崩溃广播 → 本组件错误接管态(停车区里崩的也要在下次看到时如实呈现)。
  useEffect(
    () =>
      ghostPanelWebviewPool.onCrash((ghostId) => {
        if (ghostId === manifest.id) setCrashed(true);
      }),
    [manifest.id],
  );

  // 物化 + 收养:可见(或已有 entry)→ acquire(指纹变化时池内自动重建)→
  // 把 wrapper 搬进 slot。useLayoutEffect 在 paint 前移 DOM,避免闪帧。
  // cleanup 只"停回停车区",不做释放决策 —— 释放归下面的 unmount effect,
  // 否则 active 切换(visible 翻转)就会把未钉住面板的 webview 错杀。
  useLayoutEffect(() => {
    if (crashed) return;
    const host = hostRef.current;
    if (!host) return;
    let entry = ghostPanelWebviewPool.peek(manifest.id);
    if (!entry && !visible) return; // 懒物化:没看过就不创建
    entry = ghostPanelWebviewPool.acquire(manifest);
    if (!entry) return; // 清单没有 panel.html(理论上注册时已过滤)
    if (entry.crashed) {
      setCrashed(true);
      return;
    }
    const wrapper = entry.wrapper;
    host.appendChild(wrapper);
    return () => {
      // release 后的旧 wrapper 已不归池持有,不能因 effect cleanup 被停回
      // 停车区(browserWebviewPool/BrowserTabBody 同款归属判断)。
      if (ghostPanelWebviewPool.peek(manifest.id)?.wrapper !== wrapper) {
        wrapper.remove();
        return;
      }
      const parking = document.getElementById(GHOST_PANEL_POOL_CONTAINER_ID);
      if (parking) parking.appendChild(wrapper);
      else wrapper.remove();
    };
  }, [manifest, visible, crashed, reloadGeneration]);

  // 收养期内的媒体右键菜单:与 GhostChipPanelBody 同一套过闸 + 自绘菜单。
  useEffect(() => {
    if (crashed) return;
    const entry = ghostPanelWebviewPool.peek(manifest.id);
    if (!entry) return;
    let disposed = false;
    const onContextMenu = (e: ContextMenuEvent) => {
      const uri = pickGhostPanelMediaUri(e.params, manifest.id);
      if (!uri) return;
      const pos = { x: e.params.x, y: e.params.y };
      void window.electronAPI.ghosts.resolvePanelMedia(uri, 'menu').then(
        ({ url, kind }) => {
          if (disposed) return;
          const active = document.activeElement;
          if (active instanceof HTMLElement) active.blur();
          setMediaMenu({ ...pos, url, kind: kind ?? 'image' });
        },
        () => {
          /* 过闸失败:静默不弹(与停靠形态同纪律)。 */
        },
      );
    };
    entry.webview.addEventListener('context-menu', onContextMenu);
    return () => {
      disposed = true;
      entry.webview.removeEventListener('context-menu', onContextMenu);
      setMediaMenu(null);
    };
    // visible / reloadGeneration 入依赖:懒物化与崩溃重载都可能在本 effect
    // 首跑之后才创建 entry,需要重跑补绑监听。
  }, [manifest.id, crashed, visible, reloadGeneration]);

  // 真正的释放决策只在组件 unmount(页签关闭 / 会话切换换批 / 插件注销):
  // 钉住 → 保活停车区;未钉住 → 释放,维持"仅当前会话"的旧语义。
  // manifest.id 走 ref 同步给 cleanup 闭包(BrowserTabBody 的 releaseTabIdRef 同款)。
  const ghostIdRef = useRef(manifest.id);
  ghostIdRef.current = manifest.id;
  useEffect(() => {
    return () => {
      const ghostId = ghostIdRef.current;
      if (!isGhostTabPinned(ghostId)) ghostPanelWebviewPool.release(ghostId);
    };
  }, []);

  if (crashed) {
    return (
      <GhostPanelError
        manifest={manifest}
        state="crashed"
        onReload={() => {
          ghostPanelWebviewPool.release(manifest.id);
          setCrashed(false);
          setReloadGeneration((g) => g + 1);
        }}
      />
    );
  }
  // data-ghost-webview:拖缝/拖面板期间 body.resizing-pane 指针穿透(与停靠形态同款)。
  return (
    <>
      <div ref={hostRef} data-ghost-webview className="flex min-h-0 flex-1" />
      {mediaMenu ? (
        <GhostPanelMediaMenu menu={mediaMenu} onClose={() => setMediaMenu(null)} />
      ) : null}
    </>
  );
}
