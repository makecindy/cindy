import { useCallback, useEffect, useRef, type RefObject } from 'react';

/**
 * 从项目行菜单置顶／取消置顶后，项目行会在「置顶」段与项目列表之间换父节点并重新挂载；
 * 菜单的 Radix trigger 又只是零尺寸 aria-hidden 定位点，焦点会掉到 body，打断键盘操作
 * （DESIGN.md §14.2 焦点回归）。这里在切换前记下项目与相邻行，置顶集合变化后把焦点交给
 * 新位置的同一项目行；它不可见（段已收起、被筛选挡住）时退到原位置最近的仍可见项目行。
 */

const PROJECT_HEADER = '[data-project-header]';
const PROJECT_WRAPPER = '[data-project-workingdir]';
const HIDDEN_ANCESTOR = '[data-sidebar-section-collapsed="true"], [inert], [hidden]';

interface PinFocusIntent {
  projectKey: string;
  /** 原位置的后续行在前、前序行由近及远在后。 */
  neighbors: HTMLElement[];
}

function headerProjectKey(header: Element): string | null {
  return header.closest(PROJECT_WRAPPER)?.getAttribute('data-project-workingdir') ?? null;
}

function canReceiveFocus(el: HTMLElement): boolean {
  return el.isConnected && el.closest(HIDDEN_ANCESTOR) === null;
}

export function useProjectPinFocusHandoff(
  rootRef: RefObject<HTMLElement | null>,
  pinnedRevision: unknown,
): (projectKey: string) => void {
  const pendingRef = useRef<PinFocusIntent | null>(null);

  useEffect(() => {
    const intent = pendingRef.current;
    pendingRef.current = null;
    const root = rootRef.current;
    if (!intent || !root) return;
    // 只接管已掉到 body 的焦点；用户或其他浮层已经拿走焦点时不抢。
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const headers = Array.from(root.querySelectorAll<HTMLElement>(PROJECT_HEADER));
    const target =
      headers.find((el) => headerProjectKey(el) === intent.projectKey && canReceiveFocus(el)) ??
      intent.neighbors.find((el) => root.contains(el) && canReceiveFocus(el));
    target?.focus();
  }, [pinnedRevision, rootRef]);

  return useCallback(
    (projectKey: string) => {
      const root = rootRef.current;
      if (!root) return;
      const headers = Array.from(root.querySelectorAll<HTMLElement>(PROJECT_HEADER));
      const index = headers.findIndex((el) => headerProjectKey(el) === projectKey);
      if (index < 0) return;
      pendingRef.current = {
        projectKey,
        neighbors: [...headers.slice(index + 1), ...headers.slice(0, index).reverse()],
      };
    },
    [rootRef],
  );
}
