import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Spinner } from '@/components/ui/spinner';

type LocalAdoptionPhase = 'confirm' | 'running' | 'done' | 'failed' | null;

/**
 * LocalDataAdoptionDialog — local 模式数据认领(local-v1 → 登录账号)的全局
 * 确认 / 进度界面。
 *
 * main 在登录成功、账号库打开前检测到本机模式存有会话时,经
 * `local-adoption:state` 推送阶段;本组件挂在 App 顶层(与 LegacyMigrationDialog
 * 同层、同视觉族),按阶段渲染:
 *  - confirm:标题 + 说明 + 双按钮「并入当前账号」(主)/「保留在本机模式」(次)
 *    ——归属裁决必须显式二选一,不可关闭 / 不可取消;
 *  - running:主按钮进 loading(compositor-only Spinner),次按钮隐藏;
 *  - failed:同一张卡换失败文案,点击页面任意处或按 Escape/Enter/Space 关闭
 *    (main 侧同步清态;下次登录自动重试);
 *  - done:直接关闭,登录流程继续(并入与「保留本机」都走 done 解除)。
 *
 * 视觉与几何完全沿用 LegacyMigrationDialog(490×360 r26 卡、login-callback
 * component token 族,Light/Dark 二态由 token 承载);次按钮用卡底 + 卡描边 +
 * 标题色的低强调样式,同族 token,不引入新色值。
 *
 * 挂载时经 get-state 补拉一次,兜住「main 先推送、组件后挂载」的时序。
 */
export function LocalDataAdoptionDialog() {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<LocalAdoptionPhase>(null);

  useEffect(() => {
    let mounted = true;
    window.electronAPI.localAdoption
      .getState()
      .then((state) => {
        if (mounted && state?.phase) setPhase(state.phase);
      })
      .catch(() => {});
    const unsubscribe = window.electronAPI.localAdoption.onState((payload) => {
      if (payload && typeof payload.phase === 'string') setPhase(payload.phase);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const open = phase === 'confirm' || phase === 'running' || phase === 'failed';
  const failed = phase === 'failed';
  const running = phase === 'running';
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const secondaryRef = useRef<HTMLButtonElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (failed || running) containerRef.current?.focus();
  }, [failed, running]);

  if (!open) return null;

  const dismissFailed = () => {
    if (!failed) return;
    setPhase(null);
    // 任一裁决通道都能让 main 清掉 failed 态(无 pending resolver 时仅清态),
    // 避免重挂载后 get-state 再弹;语义上传 keep 最中性。
    void window.electronAPI.localAdoption.decide('keep');
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Tab') {
      // confirm 态在双按钮间循环;running/failed 圈回容器(最小 focus trap)。
      event.preventDefault();
      if (phase === 'confirm') {
        const target =
          document.activeElement === primaryRef.current
            ? secondaryRef.current
            : primaryRef.current;
        target?.focus();
        return;
      }
      containerRef.current?.focus();
      return;
    }
    if (failed && (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      dismissFailed();
    }
  };

  const onAdopt = () => {
    if (phase !== 'confirm') return;
    // 乐观切 loading;main 收到裁决后会紧接着推 running(幂等)。
    setPhase('running');
    void window.electronAPI.localAdoption.decide('adopt');
  };

  const onKeep = () => {
    if (phase !== 'confirm') return;
    setPhase(null);
    void window.electronAPI.localAdoption.decide('keep');
  };

  return (
    // 状态完全由 main 推送 + 用户交互驱动;confirm/running 期间不允许任何
    // 方式关闭(容器点击只在 failed 态生效)。
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="local-adoption-title"
      aria-describedby="local-adoption-desc"
      tabIndex={-1}
      // z-[10000] = 本仓模态层约定(confirm-dialog 同层);低于 Toast(10100)。
      className="fixed inset-0 z-[10000] flex items-center justify-center outline-none"
      style={{ background: 'var(--login-bg-base)' }}
      onKeyDown={onKeyDown}
      onClick={dismissFailed}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: 490,
          maxWidth: 'calc(100% - 48px)',
          minHeight: 360,
          maxHeight: 'calc(100% - 48px)',
          overflowY: 'auto',
          borderRadius: 26,
          background: 'var(--login-callback-card-bg)',
          border: '1px solid var(--login-callback-card-border)',
          padding: '22px 29px 28px',
        }}
      >
        <h2
          id="local-adoption-title"
          style={{
            margin: 0,
            fontSize: 23,
            lineHeight: 1.25,
            fontWeight: 700,
            color: 'var(--login-callback-title)',
            textAlign: 'center',
          }}
        >
          {t(failed ? 'localAdoption.failedTitle' : 'localAdoption.title')}
        </h2>
        <p
          id="local-adoption-desc"
          style={{
            margin: '22px 0 0',
            fontSize: 19,
            lineHeight: '29px',
            color: 'var(--login-callback-body)',
          }}
        >
          {t(failed ? 'localAdoption.failedDescription' : 'localAdoption.description')}
        </p>
        <div style={{ flexGrow: 1, minHeight: 24 }} />
        {!failed && (
          <>
            <button
              ref={primaryRef}
              type="button"
              autoFocus
              disabled={running}
              onClick={onAdopt}
              style={{
                position: 'relative',
                alignSelf: 'center',
                width: 389,
                maxWidth: '100%',
                minHeight: 58,
                borderRadius: 9999,
                background: 'var(--login-callback-cta-bg)',
                border: '1px solid var(--login-callback-cta-border)',
                color: 'var(--login-callback-cta-text)',
                fontSize: 17,
                fontWeight: 700,
                padding: '0 46px',
                cursor: running ? 'default' : 'pointer',
              }}
            >
              {running ? (
                <>
                  {t('localAdoption.migrating')}
                  {/* spinner 右置;外层 static wrapper 定位,旋转只发生在 Spinner
                      自身 wrapper 上(compositor-only) */}
                  <span
                    style={{
                      position: 'absolute',
                      right: 21,
                      top: '50%',
                      marginTop: -9,
                      display: 'inline-flex',
                    }}
                  >
                    <Spinner size={17} />
                  </span>
                </>
              ) : (
                t('localAdoption.adopt')
              )}
            </button>
            {!running && (
              <button
                ref={secondaryRef}
                type="button"
                onClick={onKeep}
                style={{
                  alignSelf: 'center',
                  width: 389,
                  maxWidth: '100%',
                  minHeight: 58,
                  marginTop: 12,
                  borderRadius: 9999,
                  background: 'var(--login-callback-card-bg)',
                  border: '1px solid var(--login-callback-card-border)',
                  color: 'var(--login-callback-title)',
                  fontSize: 17,
                  fontWeight: 700,
                  padding: '0 46px',
                  cursor: 'pointer',
                }}
              >
                {t('localAdoption.keep')}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
