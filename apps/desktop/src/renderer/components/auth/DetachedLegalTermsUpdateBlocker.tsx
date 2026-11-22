import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { LOGIN_COLORS } from '@/components/login/loginDesignTokens';
import { useAuth } from '@/contexts/AuthContext';
import { acquireAppInteractionLock } from '@/lib/appInteractionLock';

/** 与主窗口的协议更新确认同层:盖过应用内所有浮层。 */
const BLOCKER_Z_INDEX = 10030;

/**
 * 分离侧栏 / 单页签窗口的协议更新遮挡。
 *
 * 这些窗口用专用 preload,刻意不带登录与设置能力,所以这里不提供「同意」「退出登录」,只挡住
 * 界面并提示回主窗口确认;主窗口确认后经设置广播自动解除。判定口径与 LegalTermsUpdateGate
 * 一致:只对已登录的个人账号生效。
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

  useEffect(() => {
    if (!open) return undefined;
    return acquireAppInteractionLock();
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      data-testid="detached-legal-terms-blocker"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="detached-legal-terms-title"
      aria-describedby="detached-legal-terms-body"
      className="fixed inset-0 grid place-items-center p-6"
      style={{ background: LOGIN_COLORS.consentOverlay, zIndex: BLOCKER_Z_INDEX }}
    >
      <div
        className="w-full max-w-[340px] rounded-[18px] px-5 py-5 text-center"
        style={{ background: LOGIN_COLORS.panelBg, boxShadow: `inset 0 0 0 1px ${LOGIN_COLORS.panelBorder}` }}
      >
        <p id="detached-legal-terms-title" className="text-16 font-bold" style={{ color: LOGIN_COLORS.titleText }}>
          {t('legalTermsUpdate.title')}
        </p>
        <p id="detached-legal-terms-body" className="mt-2 text-13 leading-5" style={{ color: LOGIN_COLORS.secondaryText }}>
          {t('legalTermsUpdate.detachedBody')}
        </p>
      </div>
    </div>,
    document.body,
  );
}
