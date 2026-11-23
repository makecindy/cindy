import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { acquireAppInteractionLock } from '@/lib/appInteractionLock';
import { Z_INDEX_LAYERS } from '@/styles/generated/token-mappings';

/** 查询迟迟不回时的兜底:超时后按「不需要确认」放行,不让窗口一直被无形遮挡锁住。 */
const PENDING_TIMEOUT_MS = 5_000;

type LegalStatus = 'pending' | 'required' | 'clear';

/**
 * 分离侧栏 / 单页签窗口的协议更新遮挡。
 *
 * 这些窗口用专用 preload,刻意不带登录与设置能力,所以这里不提供「同意」「退出登录」,只挡住
 * 界面并提示回主窗口确认;主窗口确认后经设置广播自动解除。判定口径与 LegalTermsUpdateGate
 * 一致:只对已登录的个人账号生效。
 *
 * 账号与协议状态都确定之前先用透明遮挡层接住输入(不显示内容,避免每次打开都闪一下):
 * 已恢复的终端 / 浏览器页签不能在判定完成前收到按键。查询失败或超时按「不需要」放行。
 *
 * 外观用应用内共享的 `.modal-scrim` / `.modal-panel`(DESIGN.md §4);判定中的透明遮挡不显示内容。
 * 模态语义与主窗口确认弹窗一致(DESIGN.md §14.2):焦点收进遮挡层、背景兄弟节点 inert,
 * Tab 不会落回被盖住的控件;解除后焦点归还。交互锁另外挡住全局快捷键。
 */
export function DetachedLegalTermsUpdateBlocker() {
  const { t } = useTranslation();
  const { mode, user, isInitializing } = useAuth();
  const [legal, setLegal] = useState<LegalStatus>('pending');

  useEffect(() => {
    const api = window.electronAPI;
    let cancelled = false;
    let sawBroadcast = false;
    const settle = (next: LegalStatus) => {
      if (!cancelled) setLegal(next);
    };
    const timeout = window.setTimeout(() => {
      setLegal((current) => (current === 'pending' ? 'clear' : current));
    }, PENDING_TIMEOUT_MS);
    const unsubscribe = api.onLegalTermsUpdateRequiredChange?.((value) => {
      sawBroadcast = true;
      settle(value ? 'required' : 'clear');
    });
    if (!api.getLegalTermsUpdateRequired) {
      settle('clear');
    } else {
      void api
        .getLegalTermsUpdateRequired()
        .then((value) => {
          if (!sawBroadcast) settle(value === true ? 'required' : 'clear');
        })
        .catch(() => {
          if (!sawBroadcast) settle('clear');
        });
    }
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      unsubscribe?.();
    };
  }, []);

  const pending = legal === 'pending' || isInitializing;
  const open = !pending && legal === 'required' && mode === 'cloud' && user?.membershipKind === 'personal';
  const blocking = pending || open;

  const containerRef = useRef<HTMLDivElement | null>(null);

  // layout effect:在浏览器绘制、用户能操作之前就加锁并收拢焦点。
  useLayoutEffect(() => {
    if (!blocking) return undefined;
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
  }, [blocking]);

  if (!blocking) return null;

  // 遮挡层内没有可操作控件:Tab 一律留在容器上,不让焦点回到被盖住的界面。
  const keepFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      containerRef.current?.focus();
    }
  };

  return createPortal(
    <div
      data-testid={open ? 'detached-legal-terms-blocker' : 'detached-legal-terms-pending'}
      role={open ? 'alertdialog' : undefined}
      aria-modal={open ? true : undefined}
      aria-busy={open ? undefined : true}
      aria-labelledby={open ? 'detached-legal-terms-title' : undefined}
      aria-describedby={open ? 'detached-legal-terms-body' : undefined}
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={keepFocus}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.focus();
      }}
      className={cn('fixed inset-0 grid place-items-center p-4 outline-none', open && 'modal-scrim')}
      style={{ zIndex: Z_INDEX_LAYERS['blocking-gate'] }}
    >
      {open && (
        <div className="modal-panel w-full max-w-[min(400px,calc(100vw-32px))] p-4">
          <h2 id="detached-legal-terms-title" className="text-lg font-medium text-[var(--confirm-title)]">
            {t('legalTermsUpdate.title')}
          </h2>
          <p id="detached-legal-terms-body" className="mt-2 text-base text-[var(--confirm-desc)]">
            {t('legalTermsUpdate.detachedBody')}
          </p>
        </div>
      )}
    </div>,
    document.body,
  );
}
