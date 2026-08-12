import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleAlert, Copy, FolderOpen } from 'lucide-react';
import type { ContextMenuEvent, WebviewTag } from 'electron';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/lib/toast';

import { GHOST_SCHEME, ghostPartition, type GhostManifest } from '../../shared/ghost';
import { createGhostThemeInjector, observeHostTheme } from './ghostPanelTheme';
import {
  clearGhostUnread,
  useElementVisible,
  useGhostUnread,
  useHostWindowForeground,
} from './ghostUnreadStore';

/**
 * 意识面板体(webview 供片)—— 顶层停靠 pane(ghostPanels)与插件页内面板
 * (features/plugin/GhostPagePanelHost)共用的渲染内核,从 ghostPanels.tsx 原样抽出:
 * 沙箱 webview 装载、主题注入、崩溃接管、媒体右键菜单,全部与宿主容器无关。
 * 安全边界不变:分区/地址由 main 侧 webview 附加闸验明正身(webview-security),
 * 本模块不因换容器多要任何特权。
 */

/**
 * 面板错误接管态:芯片型意识崩溃 / 熔断时面板**不关闭**,
 * 原地显示错误信息 + 两个动作——「重载意识」(清熔断记账重新拉起)与
 * 「关闭意识」(转沉睡,面板收起,可到设置里再唤醒)。
 */
export function GhostPanelError({
  manifest,
  state,
  onReload,
}: {
  manifest: GhostManifest;
  state: string;
  /** 重载动作;缺省走 ghosts:reload(离屏沙箱路径),面板 webview 路径传本地重挂载。 */
  onReload?: () => void;
}): ReactNode {
  const { t } = useTranslation();
  const reload = onReload ?? (() => void window.electronAPI.ghosts.reload(manifest.id).catch(() => {}));
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4">
      <CircleAlert size={22} className="text-[var(--error-fg)]" />
      <p className="text-center text-12 leading-relaxed text-[var(--text-secondary)]">
        {t(state === 'fused' ? 'settings.ghosts.panelError.fused' : 'settings.ghosts.panelError.crashed')}
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={reload}
          className="rounded-full border border-[var(--border-default)] px-3.5 py-1.5 text-12 font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-chip)]"
        >
          {t('settings.ghosts.panelError.reload')}
        </button>
        {/* 关闭 = 转沉睡,可逆动作,按 docs/design-rules/cindy-design-system.md 红色纪律走灰度次按钮(红只留错误图标)。 */}
        <button
          type="button"
          onClick={() => void window.electronAPI.ghosts.setEnabled(manifest.id, false).catch(() => {})}
          className="rounded-full border border-[var(--border-default)] px-3.5 py-1.5 text-12 font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-chip)]"
        >
          {t('settings.ghosts.panelError.close')}
        </button>
      </div>
    </div>
  );
}

/** 面板媒体右键菜单的一次弹出:坐标(宿主窗口系)+ 主机换发的地址与类别。 */
export interface GhostPanelMediaMenuState {
  x: number;
  y: number;
  /** 主机拼装的 cindy-media:// 地址(过闸产物,直接喂通用媒体 IPC)。 */
  url: string;
  kind: 'image' | 'video';
}

/**
 * 意识面板产物的右键菜单:与聊天流 ChatImageView / ChatVideoView
 * 右键同款动作——复制文件(copyMediaToClipboard,文件引用形式)+ 打开所在
 * 目录(showItemInFolder)。菜单是宿主自绘(webview 里的右键经 Electron
 * context-menu 事件转出,面板自己画不了也伪造不了),地址已过 main 闸换发,
 * 两个动作走与聊天媒体完全相同的通用 IPC。
 * (页签形态的面板体右键走同一套菜单。)
 */
export function GhostPanelMediaMenu({
  menu,
  onClose,
}: {
  menu: GhostPanelMediaMenuState;
  onClose: () => void;
}): ReactNode {
  const { t } = useTranslation();

  async function handleCopy(): Promise<void> {
    const res = await window.electronAPI.copyMediaToClipboard({ url: menu.url });
    if (res.success) {
      toast.success(t(menu.kind === 'video' ? 'chat.media.videoCopied' : 'chat.media.imageCopied'));
    } else {
      toast.error(res.error ?? t('chat.media.copyFailed'));
    }
    onClose();
  }

  async function handleReveal(): Promise<void> {
    const res = await window.electronAPI.showItemInFolder({ url: menu.url });
    if (!res.success) {
      toast.error(res.error ?? t('chat.media.openFolderFailed'));
    }
    onClose();
  }

  return (
    <DropdownMenu
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          style={{
            position: 'fixed',
            left: menu.x,
            top: menu.y,
            width: 0,
            height: 0,
            pointerEvents: 'none',
          }}
        />
      </DropdownMenuTrigger>
      {/* z-index 必须压过 webview:与 lightbox / 对话框等「webview 上方浮层」
          同档(z-[10000]);默认 z-50 会被面板 webview 的合成层盖住——菜单
          开了但看不见(指针事件已被 Radix 关掉,表现为光标变默认箭头)。 */}
      <DropdownMenuContent align="start" sideOffset={2} style={{ zIndex: 10000 }}>
        <DropdownMenuItem onClick={handleCopy}>
          <Copy className="mr-2 h-4 w-4" />
          {t(menu.kind === 'video' ? 'chat.media.copyVideo' : 'chat.media.copyImage')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleReveal}>
          <FolderOpen className="mr-2 h-4 w-4" />
          {t(menu.kind === 'video' ? 'chat.media.revealVideo' : 'chat.media.revealImage')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 从一次 webview 右键的命中参数里挑出本意识的媒体地址;不是媒体 cell 返回 null。
 * srcURL 优先(直接右键在 <img> / <video> 上,/media/ 形状),linkURL 兜底
 * (视频缩略 pointer-events:none 时命中的是外层 <a>,/preview/ 形状)。
 * 只认**本面板意识 id** 前缀——面板里出现别的意识地址(理论上只能是作者硬写)
 * 不弹菜单;严校验(指纹形状/归属/mime)仍在 main 闸,这里只是粗筛。
 */
export function pickGhostPanelMediaUri(
  params: { srcURL?: string; linkURL?: string },
  ghostId: string,
): string | null {
  const re = new RegExp(`^${GHOST_SCHEME}://${ghostId}/(media|preview)/[^/?#]+$`);
  for (const candidate of [params.srcURL, params.linkURL]) {
    if (candidate && re.test(candidate)) return candidate;
  }
  return null;
}

/**
 * 芯片型意识的自绘面板体:一块沙箱 webview 装载意识自己的
 * panel.html——分区/地址由 main 侧 webview 附加闸验明正身(webview-security),
 * 主题 token 在 dom-ready 注入、主机换肤时重灌(ghostPanelTheme)。
 * webview 崩溃 = 本地错误接管态(重载 = 原地重挂载,不经主机)。
 */
export function GhostChipPanelBody({ manifest }: { manifest: GhostManifest }): ReactNode {
  const [crashed, setCrashed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [mediaMenu, setMediaMenu] = useState<GhostPanelMediaMenuState | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);

  /**
   * 面板体挂载 = 未读已读(badge 槽的 explicit 清零)。
   *
   * 清零收在这里而不是各宿主的"打开"动作里:面板体有三个宿主(插件页页签
   * GhostPagePanelHost、布局停靠 ghostPanels、独立窗口 GhostPanelWindowLayout),
   * 挂载到本组件才是"内容确实在用户眼前"的唯一判据,三处天然对称。
   * unread 进依赖:面板**已经开着**时插件又点亮一次(后台拿到新内容),用户
   * 正看着它,不该留一颗清不掉的点。
   *
   * 清零的必要条件是**两层可见性同时成立**,缺一层都会把用户没看见的未读吞掉:
   *   1. `foreground` —— 宿主窗口可见且聚焦。停靠面板与独立面板窗口长期挂着,
   *      只看挂载的话,窗口最小化 / 失焦期间到来的未读会被一律清掉,常开面板的
   *      用户从此收不到这个插件的提醒(codex review P1)。
   *   2. `visible` —— 本面板**自己**占着可见面积。光有第 1 层还不够:同一个前台
   *      窗口里,另一个停靠面板被最大化时本面板仍然挂载,却被压成零宽/隐藏,
   *      用户根本没看到内容(codex review)。
   * 两层都满足的那一刻 effect 重跑并清零,语义正是「他看的时候才算看过」。
   */
  const unread = useGhostUnread(manifest.id);
  const foreground = useHostWindowForeground();
  const { ref: observeHost, visible } = useElementVisible();
  // 同一个 div 既要给 webview 挂载用(命令式 hostRef),又要被可见性观察器盯住。
  // 合成一个 callback ref:崩溃走 fallback 时它带 null 触发(观察器解绑),
  // 用户「重载」生成新 div 时又带新节点触发(观察器重挂)——正是 ref 对象做不到的。
  const setHostNode = useCallback(
    (el: HTMLDivElement | null) => {
      hostRef.current = el;
      observeHost(el);
    },
    [observeHost],
  );
  useEffect(() => {
    if (!unread || !foreground || !visible) return;
    clearGhostUnread(manifest.id);
  }, [manifest.id, unread, foreground, visible]);

  const panelHtml = manifest.panel?.html;
  useEffect(() => {
    if (crashed || !panelHtml) return;
    const host = hostRef.current;
    if (!host) return;
    const webview = document.createElement('webview') as WebviewTag;
    webview.setAttribute('partition', ghostPartition(manifest.id));
    webview.setAttribute('src', `${GHOST_SCHEME}://${manifest.id}/${panelHtml}`);
    webview.setAttribute('style', 'display:flex;flex:1 1 auto;width:100%;height:100%;');
    let disposed = false;
    let themeTimer: ReturnType<typeof setTimeout> | null = null;
    // 状态机见 createGhostThemeInjector:换肤误触发去重、dom-ready(含拖动
    // 换位触发的 Electron 整页重载)无条件重灌,规则都封在里面(带单测)。
    const injector = createGhostThemeInjector(webview);
    // 突发属性变动(换肤瞬间多个属性接连翻动)合并成一次注入。
    const scheduleInjectTheme = () => {
      if (themeTimer !== null) return;
      themeTimer = setTimeout(() => {
        themeTimer = null;
        if (!disposed) injector.inject();
      }, 50);
    };
    const onDomReady = () => injector.onDomReady();
    const onGone = () => {
      if (!disposed) setCrashed(true);
    };
    // 右键产物 cell → 宿主自绘菜单(复制文件 / 打开所在目录,与聊天媒体同款)。
    // context-menu 是 Chromium 对真实右键的原生上报,guest 脚本 dispatchEvent
    // 触发不了;地址过 main 闸(形状/归属/mime)换发 cindy-media:// 后才弹,
    // 非本意识名下的产物静默不弹(与预览闸同纪律,不给沙箱差异面)。
    const onContextMenu = (e: ContextMenuEvent) => {
      const uri = pickGhostPanelMediaUri(e.params, manifest.id);
      if (!uri) return;
      // 坐标:webview 转发的 context-menu params.x/y 已经是宿主窗口坐标系
      // (OOPIF 命中测试按根帧算;Windows 实测 2077 > 面板宽,叠加 rect 会把
      // 菜单顶出屏外),直接用,不要再加 webview 偏移。
      const pos = { x: e.params.x, y: e.params.y };
      void window.electronAPI.ghosts.resolvePanelMedia(uri, 'menu').then(
        ({ url, kind }) => {
          if (disposed) return;
          // 焦点还在 guest 里,不挪回宿主的话 Esc/方向键进不了菜单
          // (与 GhostMediaLightboxHost 同款处理)。
          const active = document.activeElement;
          if (active instanceof HTMLElement) active.blur();
          setMediaMenu({ ...pos, url, kind: kind ?? 'image' });
        },
        () => {
          /* 过闸失败:静默不弹(调用方无需区分原因)。 */
        },
      );
    };
    webview.addEventListener('dom-ready', onDomReady);
    webview.addEventListener('render-process-gone', onGone);
    webview.addEventListener('context-menu', onContextMenu);
    const unobserveTheme = observeHostTheme(scheduleInjectTheme);
    host.appendChild(webview);
    return () => {
      disposed = true;
      injector.dispose();
      if (themeTimer !== null) clearTimeout(themeTimer);
      unobserveTheme();
      webview.removeEventListener('dom-ready', onDomReady);
      webview.removeEventListener('render-process-gone', onGone);
      webview.removeEventListener('context-menu', onContextMenu);
      webview.remove();
      // 菜单与 webview 同生共死:原位升级/重载导致的重挂载把开着的旧菜单
      // 一并收掉,避免坐标/内容指向已不存在的旧面板上下文。
      setMediaMenu(null);
    };
    // version 入依赖:原位更新换版后 webview 重挂载,面板立刻跑新代码
    // (供片协议直读安装目录,不重挂会一直渲染旧版缓存的页面)。
  }, [
    crashed,
    generation,
    manifest.id,
    manifest.version,
    manifest.resolvedLocale,
    panelHtml,
  ]);

  if (crashed) {
    return (
      <GhostPanelError
        manifest={manifest}
        state="crashed"
        onReload={() => {
          setGeneration((g) => g + 1);
          setCrashed(false);
        }}
      />
    );
  }
  // data-ghost-webview:拖缝/拖面板期间 body.resizing-pane 让指针穿透
  // (globals.css 与内置浏览器 pool 同款规则)。
  return (
    <>
      <div ref={setHostNode} data-ghost-webview className="flex min-h-0 flex-1" />
      {mediaMenu ? (
        <GhostPanelMediaMenu menu={mediaMenu} onClose={() => setMediaMenu(null)} />
      ) : null}
    </>
  );
}
