import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';

import { panelPlacement } from './loginScale';
import { LOGIN_GROUP, LOGIN_LOCAL_MODE } from './loginDesignTokens';

/**
 * LoginStage — 桌面登录 1819×2098 设计画布的「面板宿主」层(demo v3.1 缩放)。
 *
 * PR2b 所有权拆分(implementation-plan Step 3b WHAT2):品牌视觉层(白底体系背景
 * 渐变/立绘/字标/Slogan)已整体迁入 `LoginBrandStage`(App 级 overlay,唯一渲染者);
 * 本组件只承载 LoginPage 唯一拥有的白色输入面板与第三方圆钮行(children),
 * 面板恒定 0.5 缩放,垂直锚点/避让计算引用 desktopScale 来映射品牌坐标系。
 *
 * - 面板恒定 0.5 缩放(用户拍板 2026-07-23,design.md §11):文字/输入框在任何窗口
 *   保持设计标准大小;垂直锚点跟随品牌层 desktopScale 画布 + 品牌避让/视口 clamp
 *   (公式见 loginScale.panelPlacement),不再与品牌层共用整画布缩放;
 * - children 渲染在登录整体组坐标系内(680×620 设计px:面板 500 + gap 40 + 圆钮 80);
 * - 本层自身 z-auto:LoginPage 根建立 z-[9990] stacking context 整体压过品牌
 *   overlay(LoginBrandStage z-[9980]),内部与窗框描边(z-30)/拖拽条(z-40)
 *   沿 PR2a 相对层序。
 */

export function useViewportSize(): { width: number; height: number } {
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return size;
}

export function LoginStage({
  children,
  ssoOrgGroupY = false,
  groupStyle,
  footer,
  bottomReserve = 0,
}: {
  children: ReactNode;
  /** sso-org 族状态登录组 y=1227,其余 1229(figma §5.1 / demo loginY)。 */
  ssoOrgGroupY?: boolean;
  /** handoff 面板入场样式(opacity/transform/transition,LoginPage 消费 context 注入)。 */
  groupStyle?: CSSProperties;
  /** 登录组下方的辅助操作区；相对于 stage 定位并参与视口底部避让计算。 */
  footer?: ReactNode;
  /** 登录组下方内容需要预留的屏幕高度，由 LoginPage 与品牌层共享同一值。 */
  bottomReserve?: number;
}) {
  const { width, height } = useViewportSize();
  const groupY = ssoOrgGroupY ? LOGIN_GROUP.ySsoOrg : LOGIN_GROUP.yDefault;
  const placement = panelPlacement(width, height, groupY, bottomReserve);

  return (
    <div
      className="fixed inset-0 overflow-hidden"
      data-testid="login-panel-stage-root"
    >
      {/* 登录整体组(680×620 设计px):恒定 0.5 缩放,垂直锚点跟随品牌画布并
          做品牌避让/视口 clamp(用户拍板 2026-07-23,design.md §11) */}
      <div
        data-testid="login-stage"
        className="absolute"
        style={{
          left: placement.centerX,
          top: placement.topY,
          width: LOGIN_GROUP.width,
          height: LOGIN_GROUP.height,
          transform: `translateX(-50%) scale(${placement.scale})`,
          transformOrigin: 'top center',
        }}
      >
        {/* 面板 + 第三方圆钮行由 children 提供;groupStyle 承载 handoff 入场样式 */}
        <div
          data-testid="login-group"
          className="absolute inset-0"
          style={groupStyle}
        >
          {children}
        </div>
      </div>
      {footer && (
        <div
          data-testid="login-stage-footer"
          className="absolute z-30 flex flex-col items-center text-center"
          style={{
            left: placement.centerX,
            top:
              placement.topY +
              LOGIN_GROUP.height * placement.scale +
              LOGIN_LOCAL_MODE.gap,
            width: `min(${LOGIN_GROUP.width}px, calc(100vw - 32px))`,
            // footer 只共享面板的可见性、交互门控与过渡时长；不复用 translateY，
            // 避免它与父级 scale 下的面板产生不同步位移。
            opacity: groupStyle?.opacity,
            transform: 'translateX(-50%)',
            pointerEvents: groupStyle?.pointerEvents,
            transition: groupStyle?.transition,
          }}
        >
          {footer}
        </div>
      )}
    </div>
  );
}
