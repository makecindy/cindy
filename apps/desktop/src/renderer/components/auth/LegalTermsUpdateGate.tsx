import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { WINDOW_DRAG_STYLE, WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { parseLegalSegments } from '@/components/login/LoginControls';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { useAnalyticsSettings } from '@/hooks/useAnalyticsSettings';
import { createLogger } from '@/lib/logger';
import { Z_INDEX_LAYERS } from '@/styles/generated/token-mappings';

import { LEGAL_LINKS } from '../../../shared/legalLinks';

import { useExclusiveLayer } from './exclusiveLayer';
import { setLegalTermsGateBlocking } from './legalTermsGateState';
import { PendingInputBlocker } from './PendingInputBlocker';

const log = createLogger('LegalTermsUpdateGate');

/** 查询迟迟不回时的兜底:超时后按「不需要确认」放行,不让应用一直被无形遮挡锁住。 */
const PENDING_TIMEOUT_MS = 5_000;

const ACTION_CLASS = 'h-auto min-h-9 min-w-[96px] max-w-full whitespace-normal [overflow-wrap:anywhere] py-1.5';

/**
 * 协议更新确认:已同意过旧版《服务条款》《隐私协议》的个人账号,进入主界面时必须先确认
 * 新版才能继续使用。交互与登录页的协议确认一致(Esc = 不同意、焦点锁在弹窗内、背景不可操作),
 * 外观用应用内共享的 `.modal-scrim` / `.modal-panel`(DESIGN.md §4),不沿用登录页皮肤。
 *
 * - 是否需要确认由 main 判定(legalTermsUpdateRequired),这里只对已登录的**个人账号**
 *   (membershipKind === 'personal')弹出:本地模式与企业组织账号(SSO)被登录页协议门豁免,
 *   设备上的同意记录不区分账号类型,不能当作个人账号的证据。新用户在登录页同意时已记录当前版本。
 * - 个人账号在协议状态查询返回前,先用透明遮挡层接住输入;查询失败按「不需要」处理,
 *   超过 5 秒未返回也放行。
 * - 遮挡期间持有应用交互锁,并通知其他自动弹出的模态暂缓(legalTermsGateState)。
 *
 * 范围:这是让老用户看到并确认新版协议、留下同意记录的提示,不是安全边界。它只挂在主窗口
 * (MainLayout),挡住主窗口的界面、全局快捷键和自动弹出的全局弹窗;已打开的分离侧栏 / 单页签
 * 窗口不在范围内(它们用受限 preload,不带设置与登录能力),用户回到主窗口即会看到确认。
 * - 同意:记录当前版本,所有窗口经设置广播同步收起。
 * - 不同意:退出登录,回到登录页;下次登录时在登录页重新同意即可。
 */
export function LegalTermsUpdateGate() {
  const { mode, user } = useAuth();
  const { state, acceptLegalTermsUpdate } = useAnalyticsSettings();
  const personal = mode === 'cloud' && user?.membershipKind === 'personal';
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (!state.loading) return undefined;
    const timer = window.setTimeout(() => setTimedOut(true), PENDING_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [state.loading]);
  const pending = personal && state.loading && !timedOut;
  const open = personal && !state.loading && state.legalTermsUpdateRequired;

  useLayoutEffect(() => {
    if (!pending && !open) return undefined;
    setLegalTermsGateBlocking(true);
    return () => setLegalTermsGateBlocking(false);
  }, [pending, open]);

  if (pending) return <PendingInputBlocker testId="legal-terms-update-pending" />;
  if (!open) return null;
  return <LegalTermsUpdateDialog onAccept={acceptLegalTermsUpdate} />;
}

function LegalTermsUpdateDialog({ onAccept }: { onAccept: () => Promise<void> }) {
  const { t } = useTranslation();
  const { logout } = useAuth();
  const [busy, setBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const agreeRef = useRef<HTMLButtonElement | null>(null);

  // 独占交互:加锁、聚焦「同意」、背景与之后新出现的弹窗都 inert(见 exclusiveLayer)。
  useExclusiveLayer(containerRef, agreeRef);

  const openLink = (url: string) => {
    void window.electronAPI?.openExternal?.(url).catch(() => undefined);
  };
  const agree = () => {
    if (busy) return;
    setBusy(true);
    onAccept()
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

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      disagree();
      return;
    }
    if (event.key !== 'Tab') return;
    // 焦点陷阱:Tab / Shift+Tab 只在弹窗内的可聚焦元素间循环。
    const root = containerRef.current;
    if (!root) return;
    const focusables = Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled])'));
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey ? active === first || !root.contains(active) : active === last || !root.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  };

  const zIndex = Z_INDEX_LAYERS['blocking-gate'];
  const linkClass =
    'font-medium text-[var(--confirm-title)] underline underline-offset-2 hover:text-[var(--confirm-desc)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';

  return createPortal(
    <div
      ref={containerRef}
      data-testid="legal-terms-update-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="legal-terms-update-title"
      aria-describedby="legal-terms-update-body"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => {
        // 点遮罩空白把焦点拉回弹窗,Esc 与 Tab 陷阱持续有效;遮罩不可点穿,也不关闭。
        if (event.target === event.currentTarget) agreeRef.current?.focus();
      }}
      className="modal-scrim fixed inset-0 outline-none"
      style={{ ...WINDOW_DRAG_STYLE, zIndex, pointerEvents: 'auto' }}
    >
      <div
        className="modal-panel fixed inset-0 m-auto flex h-fit w-full select-none flex-col p-4"
        style={{ ...WINDOW_NO_DRAG_STYLE, maxWidth: 'min(400px, calc(100vw - 32px))', zIndex }}
      >
        <h2 id="legal-terms-update-title" className="text-lg font-medium text-[var(--confirm-title)]">
          {t('legalTermsUpdate.title')}
        </h2>
        <p id="legal-terms-update-body" className="mt-2 text-base text-[var(--confirm-desc)]">
          {parseLegalSegments(t('legalTermsUpdate.body')).map((segment, index) =>
            segment.kind === 'text' ? (
              <span key={index}>{segment.text}</span>
            ) : (
              <button
                key={index}
                type="button"
                className={linkClass}
                onClick={() =>
                  openLink(segment.kind === 'terms' ? LEGAL_LINKS.termsOfService : LEGAL_LINKS.privacyPolicy)
                }
              >
                {segment.text}
              </button>
            ),
          )}
        </p>
        {/* DESIGN.md §4:次要操作在左、主操作在右。 */}
        <div className="mt-6 flex flex-wrap justify-end gap-2.5">
          <Button
            data-testid="legal-terms-update-disagree"
            size="lg"
            variant="secondary"
            palette="confirmation"
            disabled={busy}
            onClick={disagree}
            className={ACTION_CLASS}
          >
            {t('legalTermsUpdate.disagree')}
          </Button>
          <Button
            ref={agreeRef}
            data-testid="legal-terms-update-agree"
            size="lg"
            variant="primary"
            palette="confirmation"
            loading={busy}
            onClick={agree}
            className={ACTION_CLASS}
          >
            {t('legalTermsUpdate.agree')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
