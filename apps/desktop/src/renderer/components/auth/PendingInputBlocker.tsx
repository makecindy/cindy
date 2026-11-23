import { useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

import { acquireAppInteractionLock } from '@/lib/appInteractionLock';
import { Z_INDEX_LAYERS } from '@/styles/generated/token-mappings';

/**
 * 判定未完成时的透明遮挡层:不显示任何内容(避免每次启动都闪一下),但接住鼠标与键盘输入、
 * 锁住全局快捷键、把焦点收进来并让背景 inert,解除后归还焦点。
 *
 * 用于「判定结果出来前界面不能被操作」的场景(例如协议更新确认在查询返回前)。调用方负责
 * 在判定失败或超时后卸载它,不要让它无限期挡住应用。
 */
export function PendingInputBlocker({ testId }: { testId: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // layout effect:在浏览器绘制、用户能操作之前就加锁并收拢焦点。
  useLayoutEffect(() => {
    const releaseLock = acquireAppInteractionLock();
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = containerRef.current;
    root?.focus();
    const inerted: HTMLElement[] = [];
    if (root?.parentElement) {
      for (const child of Array.from(root.parentElement.children)) {
        if (child !== root && child instanceof HTMLElement && !child.inert) {
          child.inert = true;
          inerted.push(child);
        }
      }
    }
    return () => {
      for (const el of inerted) el.inert = false;
      releaseLock();
      opener?.focus();
    };
  }, []);

  const keepFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      containerRef.current?.focus();
    }
  };

  return createPortal(
    <div
      data-testid={testId}
      aria-busy
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={keepFocus}
      onMouseDown={(event) => event.currentTarget.focus()}
      className="fixed inset-0 outline-none"
      style={{ background: 'transparent', zIndex: Z_INDEX_LAYERS['blocking-gate'] }}
    />,
    document.body,
  );
}
