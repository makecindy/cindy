import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Spinner } from '@/components/ui/spinner';

type LegacyMigrationPhase = 'confirm' | 'running' | 'done' | 'failed' | null;

/**
 * LegacyMigrationDialog — 首登轻量数据迁移(mToc)的全局确认 / 进度界面。
 *
 * main 在首次登录成功、db 打开前检测到老版本 userData 时,经
 * `legacy-migration:state` 推送阶段;本组件挂在 App 顶层(与 Toast 同层),
 * 按阶段渲染(状态机与 IPC 交互与皮肤化前完全一致,本轮仅换视觉):
 *  - confirm:标题 + 说明 + 唯一的「继续」按钮(不可关闭 / 不可取消);
 *  - running:说明保留不变,按钮进 loading(文案居中 + 右侧 compositor-only
 *    Spinner,禁用;confirm/running 期间无任何关闭监听,天然拦截);
 *  - failed:同一张卡换失败文案,无按钮(figma 567:819/567:776),点击页面
 *    任意处或按 Escape/Enter/Space 关闭(main 侧同步清态——设计稿删除按钮
 *    后必须保留等价的解除路径,否则迁移失败会把用户永久锁在此屏);
 *  - done:直接关闭,登录流程继续(有意不做完成确认,遵循既有行为)。
 *
 * 视觉参数权威:figma CINDY 文件「迁移旧版本数据_white/_dark」六帧
 * (567:599/802/819 与 567:684/759/776):卡 680×500 r36、标题 32、正文 26/40
 * (左对齐 600 宽)、CTA 540×80 r40 文字 24、spinner 24 右置。App 内沿用
 * PR3 对 680 卡族的 0.72 落码系数 → 490×360 r26 / 23 / 19·29 / 389×58 r29·17。
 * 页面底不再用半透明遮罩压登录页,直接铺登录链路同族画布底
 * (`--login-bg-base`,亮 #EDEDED / 暗随 #525 token 二态接管;迁移设计帧
 * 567:684/759/776 画布即登录族);卡片颜色全部走
 * `--login-callback-*` component token(colors.ts 品牌豁免族),几何为设计稿
 * 冻结值走内联常量。仅 cn 构建触发(main 侧既有逻辑,本组件不感知区域)。
 *
 * 挂载时经 get-state 补拉一次,兜住「main 先推送、组件后挂载」的时序。
 */
export function LegacyMigrationDialog() {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<LegacyMigrationPhase>(null);

  useEffect(() => {
    let mounted = true;
    window.electronAPI.legacyMigration
      .getState()
      .then((state) => {
        if (mounted && state?.phase) setPhase(state.phase);
      })
      .catch(() => {});
    const unsubscribe = window.electronAPI.legacyMigration.onState((payload) => {
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
  // confirm/running 期间唯一可聚焦元素;Tab/Shift+Tab 一律圈回按钮(最小
  // focus trap——迁移期间禁止键盘走出本屏触达底层 UI)。failed 无按钮,
  // 焦点圈到容器自身,点击任意处或 Escape/Enter/Space 关闭。
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (failed || running) containerRef.current?.focus();
  }, [failed, running]);

  if (!open) return null;

  const dismissFailed = () => {
    if (!failed) return;
    setPhase(null);
    // 同一通道让 main 清掉 failed 态,避免重挂载后 get-state 再弹
    // (与旧版「继续」按钮完全相同的解除逻辑,仅触发方式换成点击任意处)。
    void window.electronAPI.legacyMigration.confirm();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      ((!running && buttonRef.current) || containerRef.current)?.focus();
      return;
    }
    if (failed && (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      dismissFailed();
    }
  };

  const onConfirm = () => {
    if (phase !== 'confirm') return;
    // 乐观切 loading;main 收到确认后会紧接着推 running(幂等)。
    setPhase('running');
    void window.electronAPI.legacyMigration.confirm();
  };

  return (
    // 状态完全由 main 推送 + 用户交互驱动;confirm/running 期间不允许任何
    // 方式关闭(容器点击只在 failed 态生效)。
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="legacy-migration-title"
      aria-describedby="legacy-migration-desc"
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
          id="legacy-migration-title"
          style={{
            margin: 0,
            fontSize: 23,
            lineHeight: 1.25,
            fontWeight: 700,
            color: 'var(--login-callback-title)',
            textAlign: 'center',
          }}
        >
          {t(failed ? 'legacyMigration.failedTitle' : 'legacyMigration.title')}
        </h2>
        <p
          id="legacy-migration-desc"
          style={{
            margin: '22px 0 0',
            fontSize: 19,
            lineHeight: '29px',
            color: 'var(--login-callback-body)',
          }}
        >
          {t(failed ? 'legacyMigration.failedDescription' : 'legacyMigration.description')}
        </p>
        {/* 设计稿按钮钉在卡底(bottom 39/680 卡);文案更长的语言把卡撑高时保底 24px 间距 */}
        <div style={{ flexGrow: 1, minHeight: 24 }} />
        {!failed && (
          <button
            ref={buttonRef}
            type="button"
            autoFocus
            disabled={running}
            onClick={onConfirm}
            style={{
              position: 'relative',
              alignSelf: 'center',
              width: 389,
              maxWidth: '100%',
              minHeight: 58,
              // 设计稿 r40/h80 = 半高真 pill;用 9999 表达 pill 语义,长文案把
              // 按钮撑高时圆角跟随保持胶囊形(codex review P1)。
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
                {t('legacyMigration.migrating')}
                {/* spinner 右置(figma 567:802:24px,距右缘 29/680 卡);外层
                    static wrapper 定位,旋转只发生在 Spinner 自身 wrapper 上 */}
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
              t('legacyMigration.confirm')
            )}
          </button>
        )}
      </div>
    </div>
  );
}
