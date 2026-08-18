import { createPortal } from 'react-dom';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { DismissableLayer, DismissableLayerBranch } from '@radix-ui/react-dismissable-layer';

import type { ProviderView } from '@cindy/model-providers';

import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { cn } from '@/lib/utils';

import { ProviderMark } from './ModelSelector';
import { computeFlyoutPlacement, UNIFIED_FLYOUT_GAP } from './unifiedModelSelection';

/** 浮层宽度 —— 与设计稿 v4 一致(264px)。 */
export const FLYOUT_WIDTH = 264;

/** 面板根节点的标记 —— 浮层定位在 prop 缺席时按它回落(见 resolvePanelRect)。 */
export const UNIFIED_PANEL_ATTR = 'data-unified-model-panel';

/** rail 上的供应商标 —— 复用行内同一套图标规则(ModelSelector.ProviderMark)。 */
export function ProviderRailMark({
  providerId,
  providers,
}: {
  providerId: string;
  providers: readonly ProviderView[];
}) {
  const provider = providers.find((entry) => entry.id === providerId);
  return (
    <ProviderMark
      providerId={providerId}
      {...(provider?.name !== undefined ? { name: provider.name } : {})}
      {...(provider?.routing !== undefined ? { routing: provider.routing } : {})}
      {...(provider?.logoKind !== undefined ? { logoKind: provider.logoKind } : {})}
      colorClass="text-current"
      withMargin={false}
    />
  );
}

/**
 * 定位用的「面板矩形」—— 三级回落,**绝不**直接拿行矩形当面板:
 *   1. 调用方传下来的面板元素;
 *   2. 从锚点行往上找带 `data-unified-model-panel` 的祖先(prop 还没绑上时的兜底 ——
 *      callback ref 的 state 要下一轮 render 才到,而首帧就可能 hover 到某一行);
 *   3. 都没有 → 用锚点行所在的滚动容器 / 行本身。
 *
 * 这条回落链是 2026-08-13 实测事故的修复点:第 2 级缺席时曾直接用行矩形当面板,而行比
 * 面板窄一大截,`panel.left - gap - width` 算出来的位置离面板很远(用户看到浮层飘在
 * 屏幕左侧)。
 */
function resolvePanelRect(anchorEl: HTMLElement, panelElement: HTMLElement | null): DOMRect {
  if (panelElement) return panelElement.getBoundingClientRect();
  const owner = anchorEl.closest(`[${UNIFIED_PANEL_ATTR}]`);
  if (owner instanceof HTMLElement) return owner.getBoundingClientRect();
  const list = anchorEl.closest('[role="listbox"]');
  if (list instanceof HTMLElement) return list.getBoundingClientRect();
  return anchorEl.getBoundingClientRect();
}

/**
 * 浮层宿主 —— portal 到 body 并用 fixed 定位:
 *   - 面板本体带圆角 + 滚动列表,浮层若留在面板内会被裁掉(规格 §1.3 的「圆角裁切放内层」
 *     在 portal 方案下天然满足);
 *   - Electron 的 app-region 只按布局矩形命中,故用真实 left/top 而非 transform 定位,
 *     并挂 `WINDOW_NO_DRAG_STYLE`,否则覆盖标题栏的区域会吞掉 pointer(与既有
 *     ModelOptionsFloatingPanel 同一条教训)。
 *
 * **它必须被上层选择器当成「自己人」**(2026-08-13 实测:点浮层里的深度档,整个选择器
 * 连浮层一起消失)。portal 到 body 之后有两套外层收起判定要各自安抚:
 *   - Radix Popover(设置 / 工具条的 Radix 分支):`DismissableLayerBranch` 把这棵子树
 *     注册成外层 layer 的分支,分支内的 pointerdown 不再算 outside;
 *   - MorphPopover(composer):它的 document pointerdown / focusin 判定明确豁免
 *     `[data-radix-popper-content-wrapper]` 子树(见 morph-popover.tsx),所以外层包装
 *     必须带这个属性 —— 与既有 ModelOptionsFloatingPanel 同一条机制,不另发明。
 * 内层再挂一个 `DismissableLayer`:Esc 与「点浮层之外」先收浮层,不穿透到整张面板
 * (MorphPopover 的 Esc 分层判定正是靠 `[data-radix-popper-content-wrapper] [role=dialog]`
 * 把第一次 Esc 让给内层)。
 *
 * 定位只在**锚点 / 面板元素变化**时算一次(规格 §1.3「同锚点内不重算」,防滑杆改高度
 * 导致抖动);面板元素从 null 变成真节点也要重算,否则会把首帧的兜底位置永久缓存。
 * 例外是 `repositionKey`:浮层开着时列表**结构**变了(在浮层里点 ☆ 插入收藏小节,锚点行
 * 整体下移)会脱锚 —— 那不是滑杆改高度那类自激抖动,必须按当前锚点矩形重算一次。
 */
export function UnifiedFlyoutHost({
  anchorEl,
  panelElement,
  flyoutRef,
  className,
  repositionKey,
  onPointerEnter,
  onPointerLeave,
  onDismiss,
  children,
}: {
  anchorEl: HTMLElement | null;
  panelElement: HTMLElement | null;
  flyoutRef: RefObject<HTMLDivElement | null>;
  className?: string;
  /**
   * 「列表结构变了」的身份值(调用方传 sections 之类的引用即可)。值变化 = 锚点行可能
   * 已经位移,清缓存按当前 rect 重算。**不要**传每帧都变的东西:那会退化成持续重算,
   * 正是「同锚点内不重算」要挡的抖动。
   */
  repositionKey?: unknown;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const [placement, setPlacement] = useState<{
    left: number;
    top: number;
    side: 'left' | 'right';
  } | null>(null);
  const placedForRef = useRef<{
    anchor: HTMLElement;
    panel: HTMLElement | null;
    repositionKey: unknown;
  } | null>(null);

  useEffect(() => {
    if (!anchorEl || typeof window === 'undefined') return;
    // 锚点行已从 DOM 卸载(收藏小节插入 / 重排可能整批重建行节点)→ 对着 detached 节点算
    // rect 只会得到一堆 0。这不由本组件收场:面板侧「锚点行消失即收起浮层」的既有逻辑
    // (flyTarget 为空 → closeFlyout)会紧接着到,这里只需按兵不动。
    if (!anchorEl.isConnected) return;
    const placedFor = placedForRef.current;
    if (
      placedFor &&
      placedFor.anchor === anchorEl &&
      placedFor.panel === panelElement &&
      placedFor.repositionKey === repositionKey &&
      placement
    ) {
      return;
    }
    placedForRef.current = { anchor: anchorEl, panel: panelElement, repositionKey };
    const frame = requestAnimationFrame(() => {
      const size = flyoutRef.current?.getBoundingClientRect();
      setPlacement(
        computeFlyoutPlacement({
          anchor: anchorEl.getBoundingClientRect(),
          panel: resolvePanelRect(anchorEl, panelElement),
          size: { width: FLYOUT_WIDTH, height: size?.height ?? 240 },
          viewport: { width: window.innerWidth, height: window.innerHeight },
        }),
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [anchorEl, flyoutRef, panelElement, placement, repositionKey]);

  if (typeof document === 'undefined') return null;
  const side = placement?.side ?? 'left';
  return createPortal(
    <DismissableLayerBranch asChild>
      <div
        // 见上:MorphPopover 的 outside / focusin 判定靠这个属性认「自己人」。
        data-radix-popper-content-wrapper=""
        data-unified-flyout-wrapper=""
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onFocusCapture={onPointerEnter}
        onBlurCapture={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          onPointerLeave();
        }}
        className="fixed z-50"
        style={{
          width: FLYOUT_WIDTH + UNIFIED_FLYOUT_GAP,
          // 行与浮层之间那条缝隙由**外层包装自己吃掉**:包装比卡片宽 gap 并把这段留白
          // 放在朝向面板的一侧,鼠标一进缝隙就已经在包装里 → pointerleave 根本不触发
          // (2026-08-13 实测:横穿缝隙时 grace 到期,浮层半路消失)。
          paddingLeft: side === 'right' ? UNIFIED_FLYOUT_GAP : 0,
          paddingRight: side === 'left' ? UNIFIED_FLYOUT_GAP : 0,
          left: placement ? (side === 'right' ? placement.left - UNIFIED_FLYOUT_GAP : placement.left) : -9999,
          top: placement?.top ?? -9999,
          visibility: placement ? undefined : 'hidden',
          ...WINDOW_NO_DRAG_STYLE,
        }}
      >
        <DismissableLayer
          asChild
          disableOutsidePointerEvents={false}
          onDismiss={onDismiss}
        >
          <div
            ref={flyoutRef}
            role="dialog"
            data-testid="unified-model-config-flyout"
            className={cn(
              // 设计稿 .flyout:padding 14px 14px 12px。
              'w-full rounded-[16px] border p-3.5 pb-3 shadow-[var(--shadow-menu)]',
              'border-[var(--model-dropdown-border)] bg-[var(--model-dropdown-bg)]',
              'transition-[top] duration-150 ease-out motion-reduce:transition-none',
              className,
            )}
          >
            {children}
          </div>
        </DismissableLayer>
      </div>
    </DismissableLayerBranch>,
    document.body,
  );
}
