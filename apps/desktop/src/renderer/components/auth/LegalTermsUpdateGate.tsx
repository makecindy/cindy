import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { LoginConsentDialog } from '@/components/login/LoginControls';
import { useAuth } from '@/contexts/AuthContext';
import { useAnalyticsSettings } from '@/hooks/useAnalyticsSettings';
import { acquireAppInteractionLock } from '@/lib/appInteractionLock';
import { createLogger } from '@/lib/logger';

import { LEGAL_LINKS } from '../../../shared/legalLinks';

const log = createLogger('LegalTermsUpdateGate');

/** 盖过应用内所有浮层(下拉 / 全屏预览等最高用到 10020):不同意就不能继续使用。 */
const GATE_Z_INDEX = 10030;

/**
 * 协议更新确认:已同意过旧版《服务条款》《隐私协议》的个人账号,进入主界面时必须先确认
 * 新版才能继续使用。复用登录页的协议确认弹窗(同一套视觉、焦点陷阱与 Esc = 不同意)。
 *
 * - 是否需要确认由 main 判定(legalTermsUpdateRequired),这里只对已登录的**个人账号**
 *   (membershipKind === 'personal')弹出:本地模式与企业组织账号(SSO)被登录页协议门豁免,
 *   设备上的同意记录不区分账号类型,不能当作个人账号的证据。新用户在登录页同意时已记录当前版本。
 * - 显示期间持有应用交互锁,全局快捷键与菜单命令不在背后继续执行。
 * - 同意:记录当前版本,所有窗口经设置广播同步收起。
 * - 不同意:退出登录,回到登录页;下次登录时在登录页重新同意即可。
 */
export function LegalTermsUpdateGate() {
  const { t } = useTranslation();
  const { mode, user, logout } = useAuth();
  const { state, acceptLegalTermsUpdate } = useAnalyticsSettings();
  const [busy, setBusy] = useState(false);
  const open =
    mode === 'cloud' &&
    user?.membershipKind === 'personal' &&
    !state.loading &&
    state.legalTermsUpdateRequired;

  useEffect(() => {
    if (!open) return undefined;
    return acquireAppInteractionLock();
  }, [open]);

  if (!open) return null;

  const openLink = (url: string) => {
    void window.electronAPI?.openExternal?.(url).catch(() => undefined);
  };
  const agree = () => {
    if (busy) return;
    setBusy(true);
    acceptLegalTermsUpdate()
      .catch((err) => log.warn('record legal terms update consent failed', err))
      .finally(() => setBusy(false));
  };
  const disagree = () => {
    if (busy) return;
    setBusy(true);
    logout()
      .catch((err) => log.warn('logout after declining legal terms update failed', err))
      .finally(() => setBusy(false));
  };

  return createPortal(
    <LoginConsentDialog
      title={t('legalTermsUpdate.title')}
      body={t('legalTermsUpdate.body')}
      agreeLabel={t('legalTermsUpdate.agree')}
      disagreeLabel={t('legalTermsUpdate.disagree')}
      onAgree={agree}
      onDisagree={disagree}
      onOpenTerms={() => openLink(LEGAL_LINKS.termsOfService)}
      onOpenPrivacy={() => openLink(LEGAL_LINKS.privacyPolicy)}
      zIndex={GATE_Z_INDEX}
    />,
    document.body,
  );
}
