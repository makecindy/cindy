import { useCallback, useRef, type CSSProperties } from 'react';
import { BRAND_NAME } from '@cindy/maker-shared/branding';

import { LOGIN_HANDOFF_TIMINGS, useLoginHandoff } from '@/contexts/LoginHandoffContext';
import { useIsDarkMode } from '@/components/markdown/useIsDarkMode';

import heroPng from '@/assets/login/hero.png';
import heroPng2x from '@/assets/login/hero@2x.png';
import heroMask from '@/assets/login/hero-mask.svg';
import wordmarkPng from '@/assets/login/wordmark.png';
import wordmarkPng2x from '@/assets/login/wordmark@2x.png';
import wordmarkDarkPng from '@/assets/login/wordmark-dark.png';
import wordmarkDarkPng2x from '@/assets/login/wordmark-dark@2x.png';
import sloganPng from '@/assets/login/slogan.png';
import sloganPng2x from '@/assets/login/slogan@2x.png';
import sloganDarkPng from '@/assets/login/slogan-dark.png';
import sloganDarkPng2x from '@/assets/login/slogan-dark@2x.png';

import { brandPlacement, sloganShiftX, splashBrandPlacement } from './loginScale';
import { HERO, LOGIN_COLORS, LOGIN_LOCAL_MODE, SLOGAN, STAGE, WORDMARK } from './loginDesignTokens';
import { useViewportSize } from './LoginStage';

/**
 * LoginBrandStage — 品牌视觉层唯一渲染者(implementation-plan Step 3b WHAT2)。
 *
 * 所有权契约(v6.12 冻结;暗色实现 PR 起画布随 light/dark 二态):
 * - 唯一渲染登录画布背景(不透明纯平底,亮 #EDEDED / 暗 #1F1F1E 经 --login-bg-base
 *   二态;2026-07-22 用户拍板对齐 PR #104 撤 wave4 双红渐变,暗色沿用纯平口径)
 *   与品牌三要素(立绘/字标/Slogan);输入面板与圆钮行归 LoginPage,绝不在此重复。
 *   暗色画布用白字版字标/SLOGAN 资产(figma 532:585),立绘两模式同资产。
 * - overlay `pointer-events: none`,不拦截 hit-test;仅主窗挂载(App.tsx 与 Splash
 *   同源 gating),z-[9980] 盖住主界面、低于 LoginPage 面板层(z-[9990])与
 *   SplashScreen(z-[9999])。
 * - 内部分层冻结:静态 full-viewport 背景子层(纯平白底,viewport 锚定)与
 *   可动画内容子层(立绘/字标/Slogan)分离——handoff 的 transform/opacity 只作用于
 *   内容子层,背景不参与任何 handoff 变换。
 * - 不透明白底全盖机制承接自 main Splash v2(PR #104):启动加载期完全遮蔽已挂载
 *   主界面,底色消费 token 不另造字面值——本层挂载期间该机制持续生效,不得回退。
 *
 * 几何:wave4 帧(368:1375 与 Splash 五帧 379:5xx 实测同坐标)——立绘 934×934
 * @(443,275)、字标黑红版内层 423×145 @(698,1046)、SLOGAN 453.22×129.12 @(1194,866);
 * Splash 位 = 登录位(shift 段位移量 0,见 LoginHandoffContext 顶注),done 后品牌
 * 元素固定登录位。Slogan 由 handoff 控制最后出现(500ms cubic-bezier(.55,.06,.38,.96))。
 */
export function LoginBrandStage() {
  const handoff = useLoginHandoff();
  const { width, height } = useViewportSize();
  const panelBottomReserve =
    handoff.panelBottomReserve ??
    (handoff.brandLayout === 'login' ? LOGIN_LOCAL_MODE.reservedHeight : 0);
  // 品牌块整体让位(scale+translateY,构图冻结;用户拍板 2026-07-23,design.md §11)
  const { scale, translateY } =
    handoff.brandLayout === 'splash'
      ? splashBrandPlacement(width, height)
      : brandPlacement(width, height, panelBottomReserve);
  const sloganShift = sloganShiftX(width, scale);
  // 暗色画布用白字版字标/SLOGAN(figma 532:585 CINDY_Standard_White / SLOGAN #FBFBFB;
  // 深浅判定同 useBrandLogo:跟随 theme-service 挂的 dark class)。立绘两模式同资产。
  const isDark = useIsDarkMode();
  const wordmarkSrc = isDark ? wordmarkDarkPng : wordmarkPng;
  const wordmarkSrcSet = isDark
    ? `${wordmarkDarkPng} 1x, ${wordmarkDarkPng2x} 2x`
    : `${wordmarkPng} 1x, ${wordmarkPng2x} 2x`;
  const sloganSrc = isDark ? sloganDarkPng : sloganPng;
  const sloganSrcSet = isDark
    ? `${sloganDarkPng} 1x, ${sloganDarkPng2x} 2x`
    : `${sloganPng} 1x, ${sloganPng2x} 2x`;

  // 品牌资产推进锚:立绘/字标/Slogan 三图全部 settle(load 或 error 均计,防死锁)。
  const settledRef = useRef<Set<string>>(new Set());
  const reportedRef = useRef(false);
  const handleAssetSettled = useCallback(
    (key: string) => {
      if (reportedRef.current) return;
      settledRef.current.add(key);
      if (settledRef.current.size >= 3) {
        reportedRef.current = true;
        handoff.reportBrandAssetsReady();
      }
    },
    [handoff],
  );
  // 缓存命中时 onLoad 可能不触发(complete 已 true),ref 回调兜底补报。
  const assetRef = useCallback(
    (key: string) => (el: HTMLImageElement | null) => {
      if (el && el.complete) handleAssetSettled(key);
    },
    [handleAssetSettled],
  );

  if (!handoff.brandStageMounted) return null;

  // The background must stay opaque while the authenticated brand content
  // fades. Otherwise the transparent macOS vibrancy backing shows through as
  // a gray veil during the Splash → app handoff.
  const contentStyle: CSSProperties = handoff.brandExiting
    ? {
        opacity: 0,
        transition: 'opacity var(--splash-fade-duration) var(--splash-fade-easing)',
      }
    : {};

  const sloganStyle: CSSProperties = {
    left: SLOGAN.x,
    top: SLOGAN.y,
    width: SLOGAN.width,
    height: SLOGAN.height,
    opacity: handoff.sloganRevealed ? 1 : 0,
    transform: sloganShift !== 0 ? `translateX(${sloganShift}px)` : undefined,
    // 入场 transition 只在播放期挂(reduced-motion/回访直落终态无过渡)。
    transition: handoff.isPlaying
      ? `opacity ${LOGIN_HANDOFF_TIMINGS.sloganMs}ms ${LOGIN_HANDOFF_TIMINGS.sloganEasing}`
      : undefined,
  };

  return (
    <div
      aria-hidden
      data-testid="login-stage-root"
      className="pointer-events-none fixed inset-0 z-[9980] overflow-hidden"
    >
      {/* 静态背景子层:纯平底(--login-bg-base 二态,亮 #EDEDED / 暗 #1F1F1E;
          PR #104 撤渐变口径),viewport 锚定铺满,不参与 handoff 变换(v6.12 分层冻结) */}
      <div
        aria-hidden
        data-testid="login-brand-bg"
        className="absolute inset-0"
        style={{
          backgroundColor: LOGIN_COLORS.bgBase,
        }}
      />
      {/* 可动画内容子层:立绘/字标/Slogan(1819×2098 画布居中等比缩放) */}
      <div data-testid="login-brand-content" className="absolute inset-0" style={contentStyle}>
        <div
          data-testid="login-brand-canvas"
          className="absolute left-1/2 top-1/2"
          style={{
            width: STAGE.width,
            height: STAGE.height,
            transform: `translate(-50%, calc(-50% + ${translateY}px)) scale(${scale})`,
            transformOrigin: '50% 50%',
            // The layout switch is synchronized with panel/slogan playback;
            // shift and terminal states remain immediate.
            transition:
              handoff.isPlaying &&
              handoff.brandLayout === 'login' &&
              (handoff.phase === 'panel' || handoff.phase === 'slogan')
                ? `transform ${LOGIN_HANDOFF_TIMINGS.panelMs}ms ${LOGIN_HANDOFF_TIMINGS.panelEasing}`
                : undefined,
          }}
        >
          <img
            alt=""
            aria-hidden
            draggable={false}
            data-testid="login-brand-hero"
            ref={assetRef('hero')}
            onLoad={() => handleAssetSettled('hero')}
            onError={() => handleAssetSettled('hero')}
            className="pointer-events-none absolute select-none object-cover"
            src={heroPng}
            srcSet={`${heroPng} 1x, ${heroPng2x} 2x`}
            style={{
              left: HERO.x,
              top: HERO.y,
              width: HERO.size,
              height: HERO.size,
              // 立绘下半渐隐融入背景(figma §4.11 mask 347:970,alpha 图像 mask,
              // 非自造 CSS gradient;资产为 Figma 原始 SVG,渐变 y=566→920 封装其中)。
              // 静态 mask 无动画,规则 7 不涉。
              // data URI 内含单引号,url() 必须双引号包裹(Vite 内联所致),
              // 否则 CSSOM 静默丢弃 mask-image。
              maskImage: `url("${heroMask}")`,
              WebkitMaskImage: `url("${heroMask}")`,
              maskMode: 'alpha',
              maskSize: `${HERO.size}px ${HERO.size}px`,
              maskRepeat: 'no-repeat',
              maskPosition: 'center',
              WebkitMaskSize: `${HERO.size}px ${HERO.size}px`,
              WebkitMaskRepeat: 'no-repeat',
              WebkitMaskPosition: 'center',
            }}
          />
          <img
            alt={BRAND_NAME}
            draggable={false}
            data-testid="login-brand-wordmark"
            ref={assetRef('wordmark')}
            onLoad={() => handleAssetSettled('wordmark')}
            onError={() => handleAssetSettled('wordmark')}
            className="pointer-events-none absolute select-none object-contain"
            src={wordmarkSrc}
            srcSet={wordmarkSrcSet}
            style={{
              left: WORDMARK.inner.x,
              top: WORDMARK.inner.y,
              width: WORDMARK.inner.width,
              height: WORDMARK.inner.height,
            }}
          />
          <img
            alt=""
            aria-hidden
            draggable={false}
            data-testid="login-slogan"
            ref={assetRef('slogan')}
            onLoad={() => handleAssetSettled('slogan')}
            onError={() => handleAssetSettled('slogan')}
            className="pointer-events-none absolute select-none object-contain"
            src={sloganSrc}
            srcSet={sloganSrcSet}
            style={sloganStyle}
          />
        </div>
      </div>
    </div>
  );
}
