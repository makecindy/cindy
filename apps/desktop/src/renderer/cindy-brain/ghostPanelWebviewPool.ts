/**
 * ghostPanelWebviewPool —— 钉住插件面板页签的 webview 常驻池(按 ghostId 分)。
 *
 * 为什么要 pool:面板页签的 webview 若随 React body 卸载而销毁(会话切换会整批
 * 换掉 PluginBodyHost),面板内的页面状态(滚动位置 / 输入 / JS 运行态)全丢,
 * 钉住页签"跨会话保留"就退化成"跨会话重加载"。做法与 browserWebviewPool 一致:
 * webview DOM 保活在脱离 tab 子树的"停车区" container,切换时用 vanilla
 * `appendChild` 把同一个节点搬进目标 slot —— DOM 移动不 detach guest webContents。
 *
 * **关键:不要用 React Portal**(同 browserWebviewPool 的裁决:Portal 跨
 * reconcile 的搬动会 remove + insert,中间一帧 webview detach 丢 webContents)。
 *
 * 与 browserWebviewPool 的三点不同:
 *  - key 是 **ghostId** 而非 tabId:钉住语义是"跨会话同一块面板",各会话的页签
 *    实例共享同一个 webview;同会话内 singleton 已保证同 kind 至多一个页签。
 *  - **无 LRU 容量位**:entry 只在面板页签首次可见时懒物化(见
 *    pooledGhostPanelBody),数量上限 = 用户钉住的插件数,天然有界;取消钉住 /
 *    页签关闭 / 插件停用·卸载·换版都会显式 release。
 *  - 主题注入 / dom-ready 重灌挂在 pool 层:面板停在停车区期间主机换肤,
 *    也要保持 token 同步,回到前台不闪错色。
 *
 * 沙箱边界零变化:partition / src 与 GhostChipPanelBody 完全同源,main 侧
 * will-attach-webview 附加闸只认分区与地址,不认宿主容器(webview-security)。
 * 沙箱生命周期纪律:插件沉睡 / 卸下时 syncGhostTabRegistrations 会调 sync()
 * 释放对应 entry —— 常驻只延长 DOM 存续,不延长沙箱生命周期。
 */

import type { WebviewTag } from 'electron';

import { GHOST_SCHEME, ghostPartition, type GhostManifest } from '../../shared/ghost';
import { createGhostThemeInjector, observeHostTheme } from './ghostPanelTheme';

export const GHOST_PANEL_POOL_CONTAINER_ID = 'ghost-panel-webview-pool';

/**
 * 面板实例的"代际指纹":版本 / 语言 / 入口页任一变化都要求重建 webview
 * (原位升级要立刻跑新代码 —— 与 GhostChipPanelBody 的 effect deps 同语义)。
 */
export function ghostPanelFingerprint(manifest: GhostManifest): string {
  return JSON.stringify([
    manifest.id,
    manifest.version,
    manifest.resolvedLocale,
    manifest.panel?.html ?? null,
  ]);
}

export interface GhostPanelPoolEntry {
  ghostId: string;
  fingerprint: string;
  /** 外层 wrapper(caller appendChild 到自己 slot;切走时搬回停车区)。 */
  wrapper: HTMLDivElement;
  /** 真 `<webview>`,挂在 wrapper 内部。 */
  webview: WebviewTag;
  /** guest 渲染进程没了(render-process-gone)。body 据此渲染错误接管态。 */
  crashed: boolean;
}

interface InternalEntry extends GhostPanelPoolEntry {
  dispose: () => void;
}

class GhostPanelWebviewPoolImpl {
  private entries = new Map<string, InternalEntry>();
  private container: HTMLDivElement | null = null;
  private crashListeners = new Set<(ghostId: string) => void>();

  /** 停车区容器(off-screen but attached,与 browserWebviewPool 同款技巧;
   *  不用 visibility:hidden —— 部分 webview 实现会因此暂停 paint)。 */
  private ensureContainer(): HTMLDivElement {
    if (this.container) return this.container;
    const existing = document.getElementById(GHOST_PANEL_POOL_CONTAINER_ID);
    if (existing instanceof HTMLDivElement) {
      this.container = existing;
      return existing;
    }
    const div = document.createElement('div');
    div.id = GHOST_PANEL_POOL_CONTAINER_ID;
    div.style.cssText =
      'position:fixed;left:-9999px;top:0;width:1px;height:1px;pointer-events:none;';
    document.body.appendChild(div);
    this.container = div;
    return div;
  }

  /**
   * 取或创建 entry。无 panel.html 的清单返回 null(调用方按"无面板"降级)。
   * 指纹不一致时先 release 再重建 —— 原位升级 / 换语言立即生效。
   */
  acquire(manifest: GhostManifest): GhostPanelPoolEntry | null {
    const panelHtml = manifest.panel?.html;
    if (!panelHtml) return null;
    const fingerprint = ghostPanelFingerprint(manifest);
    const existing = this.entries.get(manifest.id);
    if (existing) {
      if (existing.fingerprint === fingerprint) return existing;
      this.release(manifest.id);
    }
    const container = this.ensureContainer();
    const wrapper = document.createElement('div');
    wrapper.dataset.poolGhostId = manifest.id;
    // slot 给 wrapper 多大宽高 webview 跟着拉伸;背景走面板底 token,首帧过渡
    // 贴主题(browserWebviewPool 同款处理,只是面板底色用 --panel-bg)。
    wrapper.style.cssText =
      'position:relative;width:100%;height:100%;display:flex;background-color:var(--panel-bg);';
    const webview = document.createElement('webview') as WebviewTag;
    // partition / src 与 GhostChipPanelBody 完全同源;main 侧附加闸兜底验明正身。
    webview.setAttribute('partition', ghostPartition(manifest.id));
    webview.setAttribute('src', `${GHOST_SCHEME}://${manifest.id}/${panelHtml}`);
    webview.setAttribute('style', 'display:flex;flex:1 1 auto;width:100%;height:100%;');
    wrapper.appendChild(webview);

    const entry: InternalEntry = {
      ghostId: manifest.id,
      fingerprint,
      wrapper,
      webview,
      crashed: false,
      dispose: () => undefined,
    };

    // 主题注入状态机(换肤去重 / dom-ready 无条件重灌)封装在 injector 内;
    // 突发属性变动合并成一次注入 —— 与 GhostChipPanelBody 同款节奏。
    const injector = createGhostThemeInjector(webview);
    let disposed = false;
    let themeTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleInjectTheme = () => {
      if (themeTimer !== null) return;
      themeTimer = setTimeout(() => {
        themeTimer = null;
        if (!disposed) injector.inject();
      }, 50);
    };
    const onDomReady = () => injector.onDomReady();
    const onGone = () => {
      if (disposed || entry.crashed) return;
      entry.crashed = true;
      this.fireCrash(entry.ghostId);
    };
    // 监听必须在 wrapper 接入 document 前装好(browserWebviewPool 同纪律):
    // 挂进停车区那一刻 guest 即开始加载,期间的崩溃不能丢。
    webview.addEventListener('dom-ready', onDomReady);
    webview.addEventListener('render-process-gone', onGone);
    const unobserveTheme = observeHostTheme(scheduleInjectTheme);
    entry.dispose = () => {
      disposed = true;
      injector.dispose();
      if (themeTimer !== null) clearTimeout(themeTimer);
      unobserveTheme();
      webview.removeEventListener('dom-ready', onDomReady);
      webview.removeEventListener('render-process-gone', onGone);
    };

    container.appendChild(wrapper);
    this.entries.set(manifest.id, entry);
    return entry;
  }

  /** 仅取已存在的 entry(懒物化判断用);不存在返回 null。 */
  peek(ghostId: string): GhostPanelPoolEntry | null {
    return this.entries.get(ghostId) ?? null;
  }

  /**
   * 显式销毁:wrapper 移出 DOM(guest webContents 随之被 Electron 销毁)。
   * 触发点:取消钉住后的页签卸载 / 关闭页签 / 插件停用·卸载·换版 / 崩溃重载。
   */
  release(ghostId: string): void {
    const entry = this.entries.get(ghostId);
    if (!entry) return;
    entry.dispose();
    entry.wrapper.remove();
    this.entries.delete(ghostId);
  }

  /**
   * 与"已装且启用、面板形态为页签"的清单对齐:不在清单里(停用 / 卸载 / 换
   * 形态)或指纹已变(原位升级 / 换语言)的 entry 全部释放。由
   * syncGhostTabRegistrations 在每次 ghosts 同步时调用 —— 沙箱生命周期纪律
   * (沉睡 / 抽离必须终止)在这里落地,常驻池不给被停用的插件续命。
   */
  sync(alive: ReadonlyArray<{ ghostId: string; fingerprint: string }>): void {
    const expected = new Map(alive.map((a) => [a.ghostId, a.fingerprint]));
    for (const [ghostId, entry] of [...this.entries]) {
      if (expected.get(ghostId) !== entry.fingerprint) this.release(ghostId);
    }
  }

  /**
   * 释放全部 entry。侧边栏宿主窗口切换(内嵌 ↔ 独立子窗口)时调用 —— 本
   * renderer 的 webview 即将失去宿主语义,留着就是僵尸实例(browserWebviewPool
   * 的 releaseAll 同款场景,MainLayout detach 转换 effect 一并调)。
   */
  releaseAll(): void {
    for (const ghostId of [...this.entries.keys()]) {
      this.release(ghostId);
    }
  }

  /** 订阅 guest 崩溃(body 据此切错误接管态;重载 = release + 重新 acquire)。 */
  onCrash(listener: (ghostId: string) => void): () => void {
    this.crashListeners.add(listener);
    return () => {
      this.crashListeners.delete(listener);
    };
  }

  private fireCrash(ghostId: string): void {
    for (const l of this.crashListeners) {
      try {
        l(ghostId);
      } catch {
        // listener 抛错不阻断池内状态推进
      }
    }
  }

  /** 调试 / 测试用:当前池内 ghostId 列表。 */
  inspectGhostIds(): string[] {
    return [...this.entries.keys()];
  }
}

/** 全局单例 —— 整个 renderer 进程共享一个池。 */
export const ghostPanelWebviewPool = new GhostPanelWebviewPoolImpl();
