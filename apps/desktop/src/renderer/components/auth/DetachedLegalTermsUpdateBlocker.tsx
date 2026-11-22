import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { LOGIN_COLORS } from '@/components/login/loginDesignTokens';
import { useAuth } from '@/contexts/AuthContext';
import { acquireAppInteractionLock } from '@/lib/appInteractionLock';
import { Z_INDEX_LAYERS } from '@/styles/generated/token-mappings';

/**
 * 分离侧栏 / 单页签窗口的协议更新遮挡。
 *
 * 这些窗口用专用 preload,刻意不带登录与设置能力,所以这里不提供「同意」「退出登录」,只挡住
 * 界面并提示回主窗口确认;主窗口确认后经设置广播自动解除。判定口径与 LegalTermsUpdateGate
 * 一致:只对已登录的个人账号生效。
 *
 * 模态语义与 LoginConsentDialog 一致(DESIGN.md §14.2):打开时把焦点收进遮挡层、背景兄弟节点
 * inert,Tab 不会落回被盖住的终端 / 浏览器等控件;关闭后焦点归还。交互锁另外挡住全局快捷键。
 */
export function DetachedLegalTermsUpdateBlocker() {
  const { t } = useTranslation();
  const { mode, user } = useAuth();
  const [required, setRequired] = useState(false);

  useEffect(() => {
    const api = window.electronAPI;
    let cancelled = false;
    let sawBroadcast = false;
    const unsubscribe = api.onLegalTermsUpdateRequiredChange?.((value) => {
      sawBroadcast = true;
      if (!cancelled) setRequired(value);
    });
    void api
      .getLegalTermsUpdateRequired?.()
      .then((value) => {
        if (!cancelled && !sawBroadcast) setRequired(value === true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const open = required && mode === 'cloud' && user?.membershipKind === 'personal';

  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
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
  }, [open]);

  if (!open) return null;

  // 遮挡层内没有可操作控件:Tab 一律留在容器上,不让焦点回到被盖住的界面。
  const keepFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      containerRef.current?.focus();
    }
  };

  return createPortal(
    <div
      data-testid="detached-legal-terms-blocker"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="detached-legal-terms-title"
      aria-describedby="detached-legal-terms-body"
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={keepFocus}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.focus();
      }}
      className="fixed inset-0 grid place-items-center p-6 outline-none"
      style={{ background: LOGIN_COLORS.consentOverlay, zIndex: Z_INDEX_LAYERS['blocking-gate'] }}
    >
      <div
        className="w-full max-w-[340px] rounded-[18px] px-5 py-5 text-center"
        style={{ background: LOGIN_COLORS.panelBg, boxShadow: `inset 0 0 0 1px ${LOGIN_COLORS.panelBorder}` }}
      >
        <p id="detached-legal-terms-title" className="text-16 font-semibold" style={{ color: LOGIN_COLORS.titleText }}>
          {t('legalTermsUpdate.title')}
        </p>
        <p id="detached-legal-terms-body" className="mt-2 text-13 leading-[1.54]" style={{ color: LOGIN_COLORS.secondaryText }}>
          {t('legalTermsUpdate.detachedBody')}
        </p>
      </div>
    </div>,
    document.body,
  );
}
