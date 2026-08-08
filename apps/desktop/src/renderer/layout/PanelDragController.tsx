/**
 * PanelDragController —— 「直接拖面板换位」正式交互(布局树 B3 转正;前身是
 * dev-only 原型 PanelDragPrototype,Lizi 体感两轮后拍板转正、不做编辑模式)。
 *
 * 手势(所有顶级面板通用,未来意识面板经标准头 §6.0 天然继承):
 *   1. 拖标准头/Tab 条:面板顶带空白处(data-panel-drag-handle)**按下即浮起**,
 *      原地松手 = 取消(标题条空白没有点击语义,即时反馈不伤任何交互);
 *   2. 长按窗体:面板任意区域按住 600ms 不动(<8px)后"浮起"进入拖动。
 *      已知边界:网页(webview)/独立进程区域宿主收不到按压事件,长按在那里
 *      天然无效(平台机制)——标准头手势是这类面板的主入口。
 *
 * 交互语义(drop-zone 式):**拖动过程不换位**;指针拖进**对面那块面板的真实
 * 矩形**(共享边内缩 12px 防贴边抖动)时,该面板区域亮起「松手会落到这里」的
 * 半透明高亮罩 —— 高亮就是会被交换的区域本身的尺寸,不是半屏;退出即熄灭。
 * **松手在高亮亮着时才写树交换**(layout.set 即持久化,LayoutRoot 收广播重排),
 * Esc / 松手在原侧 = 取消,什么都不发生。
 *
 * 性能口径(按 Lizi "卡手"反馈定型):pointermove 热路径**零 React 渲染、零
 * 布局读取**——边界几何在起拖时量一次缓存(拖动期间不换位,界面静止,没有
 * 失效场景);拖影跟手走 transform: translate3d 直改 DOM(GPU 合成,不触发
 * 排版);只有"目标区亮/灭"这种低频状态切换才 setState(一次拖动至多几次)。
 *
 * 复用 body.resizing-pane 让 webview 在拖动期间指针穿透(与拖宽同款方案),
 * 否则指针滑进浏览器 tab 区域后 pointermove 会被 guest 吃掉、拖动卡死。
 *
 * 平台口径:Windows 与 macOS 均已启用。Windows 可拖 Tab 条空白或长按窗体；
 * macOS unified topbar 保留给窗口拖动，因此只走窗体长按。macOS 交换态的控件
 * 锚定由 MainLayout / RightSidebarShell 的 M2 适配负责。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { swapRootSplitChildrenByKind } from '../../shared/layoutTree';
import { toast } from '@/lib/toast';

/** 长按窗体:按住该时长(ms)且位移小于容差才"浮起"。 */
const LONG_PRESS_MS = 600;
/** 长按期间允许的手抖位移容差(px),超过即取消长按判定。 */
const LONG_PRESS_MOVE_TOLERANCE_PX = 8;
/** 落点高亮框相对目标面板边界的内缩(px),视觉上是"悬浮在那块面板上的落点框"。 */
const DROP_ZONE_INSET_PX = 6;
/** 触发区在源/目标共享边一侧的内缩(px):指针要真正拖进目标面板一小段才点亮,防贴边抖动。 */
const ZONE_ENTER_MARGIN_PX = 12;

/**
 * 长按起拖的统一让路名单(2026-07-07 Lizi 实测拍板:在按钮/列表项上长按起拖是误触,
 * "看起来能点的东西"一律不响应长按)。语义化可交互元素 + 显式豁免标记;
 * 拖 Tab 条路径沿用各自更严的排除,不走本名单。
 */
const LONG_PRESS_EXEMPT_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'textarea',
  'select',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[contenteditable="true"]',
  '[data-panel-drag-exempt]',
].join(', ');

/** 高亮/提交共用的触发横向区间(亮着的时候松手就一定交换,所见即所得)。 */
export interface TriggerRange {
  left: number;
  right: number;
}

/**
 * 纯函数:由目标面板矩形推触发区间 —— 只在**与源面板共享的那条边**内缩入界余量
 * (指针要真正拖进目标一小段才点亮,防贴边抖动);远端边不缩,拖到窗口边缘也算在内。
 */
export function computeTriggerRange(
  rectLeft: number,
  rectRight: number,
  sourceIsLeftOfTarget: boolean,
  enterMarginPx: number = ZONE_ENTER_MARGIN_PX,
): TriggerRange {
  return sourceIsLeftOfTarget
    ? { left: rectLeft + enterMarginPx, right: rectRight }
    : { left: rectLeft, right: rectRight - enterMarginPx };
}

/** 纯函数:指针横坐标是否落在触发区间内。 */
export function isPointerInTargetZone(pointerX: number, range: TriggerRange): boolean {
  if (!(range.right > range.left)) return false;
  return pointerX >= range.left && pointerX <= range.right;
}

/** 可落靶面板的最小"身体"尺寸(px):折叠成 0 宽 / display:none 的面板没有身体,不算落点。 */
const MIN_DROP_TARGET_SIZE_PX = 40;

/**
 * 纯函数:该矩形是否够格当落点。换位语义是"拖到另一块面板身上",折叠(w-0)或
 * 隐藏(rect 全 0)的面板没有可落的身体 —— 收集落点时过滤,而不是靠上层开关
 * 猜测哪些面板在场(N 面板通用后,任何按具体面板写死的开关都是错的)。
 */
export function isDroppableRect(width: number, height: number): boolean {
  return width >= MIN_DROP_TARGET_SIZE_PX && height >= MIN_DROP_TARGET_SIZE_PX;
}


interface PanelDragControllerProps {
  /** MainLayout 的 row 容器(全宽 flex 行),用于算内容区右边界与纵向范围。 */
  rowRef: React.RefObject<HTMLDivElement | null>;
  /** 左侧占位块 wrapper(B1a 引入),用于算内容区左边界;设置页等场景为 null 按 0 计。 */
  sidebarBlockRef: React.RefObject<HTMLDivElement | null>;
  /** 工具面板当前可拖(在场 + 展开 + 非 maximize + 未弹出子窗口)。 */
  enabled: boolean;
}

interface ZoneRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 单个可落靶面板:高亮框(它的真实矩形)+ 触发区间。起拖时一次性量好。 */
interface DropTarget {
  kind: string;
  zone: ZoneRect;
  trigger: TriggerRange;
}

/** 起拖时一次性缓存的几何:全部可落靶面板(N 面板,拖到谁身上就和谁换位)。 */
interface DragGeometry {
  targets: DropTarget[];
}

/** 低频渲染状态:只在拖动开始/结束与落靶目标变化时更新,不随指针移动更新。 */
interface DragRenderState {
  targetKind: string | null;
}

export function PanelDragController({
  rowRef,
  sidebarBlockRef,
  enabled,
}: PanelDragControllerProps): ReactNode {
  const { t } = useTranslation();
  const [drag, setDrag] = useState<DragRenderState | null>(null);
  const dragActiveRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  // 热路径通道:指针位置与几何走 ref + 直改 DOM,绕过 React。
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const pointRef = useRef({ x: 0, y: 0 });
  const geometryRef = useRef<DragGeometry | null>(null);

  useEffect(() => {
    if (!enabled) return;

    /** 拖影跟手:直改 transform(GPU 合成),不进 React、不触发排版。 */
    const moveGhost = (x: number, y: number) => {
      pointRef.current = { x, y };
      const node = ghostRef.current;
      if (node) node.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    };

    /** 进入拖动态:量一次几何 + 挂全局监听 + webview 穿透 + 禁选中。 */
    const activateDrag = (sourceKind: string, startX: number, startY: number) => {
      // 可落靶面板 = root 分割里除源之外的每一个 pane(N 面板通用,拖到谁
      // 身上就和谁换位);高亮/提交区域是各自**当下的真实矩形**(Lizi 定案:
      // 高亮必须是"会被交换的那块区域"的尺寸,不是半屏)。
      // 几何一次性缓存:拖动期间不换位、界面静止,没有需要每帧重量的理由。
      const targets: DropTarget[] = [];
      try {
        const layout = window.electronAPI.layout.getStateSync().layout;
        if (layout.content.type !== 'split') return;
        const kinds = layout.content.children.map((c) =>
          c.node.type === 'pane' ? c.node.panelKind : null,
        );
        const sourceIndex = kinds.indexOf(sourceKind);
        if (sourceIndex < 0) return;
        kinds.forEach((kind, index) => {
          if (!kind || index === sourceIndex) return;
          const el = document.querySelector(`[data-panel-drag-root="${kind}"]`);
          if (!el) return; // 未注册(隐藏)的 kind 没有 DOM,自然不可落靶
          const rect = el.getBoundingClientRect();
          // 折叠(w-0)/隐藏的面板没有身体,不算落点;全过滤光则下方 targets 为空,
          // 根本不进入拖动态(按下如常点击,不浮起一张无处可落的拖影)。
          if (!isDroppableRect(rect.width, rect.height)) return;
          targets.push({
            kind,
            zone: {
              left: rect.left + DROP_ZONE_INSET_PX,
              top: rect.top + DROP_ZONE_INSET_PX,
              width: Math.max(0, rect.width - DROP_ZONE_INSET_PX * 2),
              height: Math.max(0, rect.height - DROP_ZONE_INSET_PX * 2),
            },
            // 入界余量只缩"朝源面板那侧"的共享方向:源在目标左侧则缩目标左缘。
            trigger: computeTriggerRange(rect.left, rect.right, sourceIndex < index),
          });
        });
      } catch {
        return;
      }
      if (targets.length === 0) return;
      geometryRef.current = { targets };

      dragActiveRef.current = true;
      let targetKindNow: string | null = null;
      pointRef.current = { x: startX, y: startY };
      setDrag({ targetKind: null });
      document.body.classList.add('resizing-pane');
      const prevUserSelect = document.body.style.userSelect;
      const prevBodyPointerEvents = document.body.style.pointerEvents;
      const prevRootCursor = document.documentElement.style.cursor;
      document.body.style.userSelect = 'none';
      // 拖拽态下整页停止指针命中(2026-07-07 Lizi 反馈:拖动扫过按钮/列表不该
      // 再亮 hover/选中态)。document 级 pointermove/up 监听不受影响(事件落到
      // html 上照样冒到 document),拖影/落点高亮本就 pointer-events-none。
      document.body.style.pointerEvents = 'none';
      // cursor 设在 html 上 —— body 已停止命中,光标样式从命中元素(html)取。
      document.documentElement.style.cursor = 'grabbing';
      // 长按期间 mousedown 默认行为可能已拉出文字选区,浮起时清掉。
      window.getSelection()?.removeAllRanges();

      /** 每帧:直改拖影 transform;只有落靶目标变化才 setState。 */
      const onMove = (e: PointerEvent) => {
        moveGhost(e.clientX, e.clientY);
        const geo = geometryRef.current;
        if (!geo) return;
        const hit = geo.targets.find((t) => isPointerInTargetZone(e.clientX, t.trigger));
        const nextKind = hit ? hit.kind : null;
        if (nextKind !== targetKindNow) {
          targetKindNow = nextKind;
          setDrag({ targetKind: nextKind });
        }
      };

      const finish = (opts: { commit: boolean; suppressClick: boolean }) => {
        dragActiveRef.current = false;
        geometryRef.current = null;
        setDrag(null);
        document.body.classList.remove('resizing-pane');
        document.body.style.userSelect = prevUserSelect;
        document.body.style.pointerEvents = prevBodyPointerEvents;
        document.documentElement.style.cursor = prevRootCursor;
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('keydown', onKey, true);
        cleanupRef.current = null;
        if (opts.commit && targetKindNow) {
          // 松手在高亮上 → 此刻才真正与落靶面板换位并持久化。
          try {
            const layout = window.electronAPI.layout.getStateSync().layout;
            const op = swapRootSplitChildrenByKind(layout, sourceKind, targetKindNow);
            if (op.applied) {
              void window.electronAPI.layout
                .set(op.layout)
                .then((result) =>
                  result.persisted
                    ? toast.success(t('settings.appearance.layout.saved'))
                    : toast.error(t('settings.appearance.layout.saveFailed')),
                )
                .catch(() => toast.error(t('settings.appearance.layout.saveFailed')));
            }
          } catch {
            // 同步 IPC 异常 —— 放弃本次交换并明确告诉用户没有保存。
            toast.error(t('settings.appearance.layout.saveFailed'));
          }
        }
        if (opts.suppressClick) {
          // 松手落点可能是按钮(尤其长按路径),吞掉紧随其后的这一次 click;
          // 100ms 兜底移除,避免"没有 click 跟来"时误吞用户下一次正常点击。
          const swallow = (ce: MouseEvent) => {
            ce.preventDefault();
            ce.stopPropagation();
          };
          window.addEventListener('click', swallow, { capture: true, once: true });
          window.setTimeout(
            () => window.removeEventListener('click', swallow, { capture: true } as EventListenerOptions),
            100,
          );
        }
      };
      const onUp = () => finish({ commit: true, suppressClick: true });
      const onCancel = () => finish({ commit: false, suppressClick: false });
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') finish({ commit: false, suppressClick: false });
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKey, true);
      cleanupRef.current = () => finish({ commit: false, suppressClick: false });
    };

    /** 手势识别入口:按下时区分 Tab 条(拖动阈值)与窗体(长按)。 */
    const onPointerDown = (e: PointerEvent) => {
      if (dragActiveRef.current) return;
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const root = target.closest('[data-panel-drag-root]');
      if (!root) return;
      // 标记值即面板身份(chat-main / right-tabs),两块都可拖、都往对面半区落。
      const sourceKind = root.getAttribute('data-panel-drag-root');
      if (!sourceKind) return;
      if (target.closest('[data-rsb-resize-handle]')) return; // 拖宽把手让路

      const startX = e.clientX;
      const startY = e.clientY;
      const onHandleSurface = !!target.closest('[data-panel-drag-handle]');

      if (onHandleSurface) {
        // 标准头/Tab 条:pill / 按钮等可交互元素让路;空白处**按下即浮起**
        // (2026-07-08 Lizi 拍板:抓手就该按下就给"拿起来了"的反馈,不等移动
        // 阈值 —— 标题条空白没有点击语义,按了就出卡不伤任何交互;原地松手
        // 即取消,什么都不发生)。
        if (target.closest('button, a, input, textarea, select, [role="menuitem"]')) return;
        activateDrag(sourceKind, startX, startY);
        return;
      }

      // 窗体长按:600ms 内位移 <8px 才浮起。可交互元素统一让路(原型期曾允许
      // "哪里都能长按"+click 吞噬兜底,实测在按钮/列表项上就是误触,推翻)——
      // 长按只在面板的"空地/静态内容"上有效。
      if (target.closest(LONG_PRESS_EXEMPT_SELECTOR)) return;
      const timer = window.setTimeout(() => {
        stop();
        activateDrag(sourceKind, startX, startY);
      }, LONG_PRESS_MS);
      const onMove = (me: PointerEvent) => {
        if (
          Math.abs(me.clientX - startX) > LONG_PRESS_MOVE_TOLERANCE_PX ||
          Math.abs(me.clientY - startY) > LONG_PRESS_MOVE_TOLERANCE_PX
        ) {
          stop();
        }
      };
      const stop = () => {
        window.clearTimeout(timer);
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', stop);
        document.removeEventListener('pointercancel', stop);
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', stop);
      document.addEventListener('pointercancel', stop);
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      cleanupRef.current?.();
    };
  }, [enabled, rowRef, sidebarBlockRef, t]);

  if (!drag) return null;
  const zone = drag.targetKind
    ? geometryRef.current?.targets.find((t) => t.kind === drag.targetKind)?.zone ?? null
    : null;
  // 视觉(全走主题 token,规则 16;无文案免 i18n):
  //   1. 落点高亮:半透明淡蓝罩层(VSCode 拖 tab 落点同款质感)——透出下方内容,
  //      取色基于 focus-ring 语义蓝低透明度混合,light / dark / 扩展主题都自然;
  //   2. 拖影:迷你面板骨架卡,微倾斜 + 淡入起手动画(内层卡的 transform 被
  //      居中偏移+倾斜占用,起手动画只能碰 opacity,不许上 scale 类 keyframe)。
  //      外层定位壳(translate3d 跟手,热路径直改)与内层视觉卡(居中偏移 + 倾斜)
  //      分离 —— transform 各自独立,互不覆盖。
  return createPortal(
    <>
      {zone && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[9998] rounded-xl border animate-fade-in"
          style={{
            left: zone.left,
            top: zone.top,
            width: zone.width,
            height: zone.height,
            background: 'color-mix(in srgb, var(--focus-ring) 10%, transparent)',
            borderColor: 'color-mix(in srgb, var(--focus-ring) 55%, transparent)',
          }}
        />
      )}
      <div
        aria-hidden
        ref={(node) => {
          ghostRef.current = node;
          // 挂载瞬间就位到当前指针(此后由 pointermove 直改 transform 跟手)。
          if (node) {
            node.style.transform = `translate3d(${pointRef.current.x}px, ${pointRef.current.y}px, 0)`;
          }
        }}
        className="pointer-events-none fixed left-0 top-0 z-[9999] will-change-transform"
      >
        <div
          className="h-[110px] w-[170px] rounded-xl border animate-fade-in"
          style={{
            transform: 'translate(-50%, -58%) rotate(-2deg)',
            background: 'var(--surface-elevated)',
            borderColor: drag.targetKind ? 'var(--focus-ring)' : 'var(--border-default)',
            boxShadow: 'var(--shadow-menu)',
            opacity: 0.92,
          }}
        >
          {/* 迷你骨架示意"这是一个面板":一条假 Tab 条 + 两行假内容。 */}
          <div className="mx-2 mt-2 h-[14px] w-[70%] rounded-md bg-[var(--surface-chip)]" />
          <div className="mx-2 mt-2 h-[10px] w-[85%] rounded bg-[var(--surface-chip)] opacity-70" />
          <div className="mx-2 mt-1.5 h-[10px] w-[60%] rounded bg-[var(--surface-chip)] opacity-70" />
        </div>
      </div>
    </>,
    document.body,
  );
}
