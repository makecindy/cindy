import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

import { cn } from '@/lib/utils';

import {
  BACK,
  CONTROL,
  ERROR_TEXT,
  GLOBAL_PILL,
  GLOBAL_TITLE_SPAN,
  LOADING_RING,
  LOGIN_COLORS,
  METHOD_ROW,
  PANEL,
  SOCIAL,
  SPINNER,
  SUBTITLE,
  TEXT_LINK,
  TITLE,
} from './loginDesignTokens';

/**
 * LoginControls — 登录皮肤组件库(figma-component-spec §4 逐参数重建)。
 *
 * 态系(design.md §2):
 * - hover 仅桌面(本文件即桌面端);pressed 双端;态只叠遮罩不改布局(§2.3-1)。
 * - 叠层一律挂伪元素(::after),不侵入图标/文本子节点(§2.3-4);
 *   hover/pressed 叠层为 §2.1 实测参数(rgba 字面值随行注 nodeId,非主题色;
 *   disabled 叠层走 token —— token-decision-table §3 仅 disabled 建 token)。
 * - 全部叠层/旋转 = opacity/transform,compositor-only(§2.3-3,规则 7);
 *   spinner 动画挂 HTML wrapper,SVG 静止;prefers-reduced-motion 直落终态。
 */

/** 态叠层伪元素基类(§2.3-4:overlay 挂 ::after,不动子节点)。 */
const overlayBase = cn(
  'after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit]',
  'after:opacity-0 after:transition-opacity after:content-[""]',
);

/** 面板(680×440 r36 #FBFBFB + wave4 1px inside 描边 368:1383)。 */
export function LoginPanel({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div
      data-testid={testId ?? 'login-panel'}
      className="absolute left-0 top-0 overflow-hidden"
      style={{
        width: PANEL.width,
        height: PANEL.height,
        borderRadius: PANEL.radius,
        background: LOGIN_COLORS.panelBg,
        boxShadow: `inset 0 0 0 1px ${LOGIN_COLORS.panelBorder}`,
      }}
    >
      {children}
    </div>
  );
}

/**
 * 标题块(figma §5.1:标题 y=31 h=38 32 Bold;副标题 x=41 y=75 w=599 20 Regular)。
 * global 变体:标题文字 span @(185,w236) + Global pill @(425,4)(§4.10,demo titleBlock)。
 */
export function LoginTitleBlock({
  title,
  subtitle,
  globalPill,
}: {
  title: string;
  subtitle?: ReactNode;
  globalPill?: string;
}) {
  return (
    <>
      <div
        className="absolute left-0 overflow-hidden whitespace-nowrap text-center font-bold"
        style={{
          top: TITLE.y,
          width: PANEL.width,
          height: TITLE.height,
          // 行框 = 设计 h(38 @32):缺省行高继承 body 1.5(≈48px)>容器 38 且
          // 顶对齐,overflow-hidden 会裁掉行框底部的拉丁 descender(实拍「欢迎使用
          // Cindy」y 尾被切,MT-7)——显式 lineHeight=行框高,字形完整不裁(与回调页
          // h1 line-height:38px、移动端 LoginTitleBlock 同款)。
          lineHeight: `${TITLE.height}px`,
          fontSize: TITLE.fontSize,
          color: LOGIN_COLORS.titleText,
          textOverflow: 'ellipsis',
        }}
      >
        {globalPill ? (
          <>
            <span
              className="absolute"
              style={{ left: GLOBAL_TITLE_SPAN.left, width: GLOBAL_TITLE_SPAN.width }}
            >
              {title}
            </span>
            <span
              data-testid="login-global-pill"
              className="absolute text-center font-bold"
              style={{
                left: GLOBAL_PILL.left,
                top: GLOBAL_PILL.top,
                width: GLOBAL_PILL.width,
                height: GLOBAL_PILL.height,
                borderRadius: GLOBAL_PILL.radius,
                background: LOGIN_COLORS.brandAccent,
                color: LOGIN_COLORS.invertedButtonBorder,
                fontSize: 16,
                lineHeight: `${GLOBAL_PILL.height}px`,
              }}
            >
              {globalPill}
            </span>
          </>
        ) : (
          title
        )}
      </div>
      {subtitle != null && (
        <div
          className="absolute overflow-hidden whitespace-nowrap text-center"
          style={{
            left: SUBTITLE.x,
            top: SUBTITLE.y,
            width: SUBTITLE.width,
            height: 23,
            // 同标题:显式行高 = 容器高,避免继承行高溢出后被 overflow-hidden 裁字形
            // (与回调页 .body line-height:23px 同款)。
            lineHeight: '23px',
            fontSize: SUBTITLE.fontSize,
            color: LOGIN_COLORS.secondaryText,
            textOverflow: 'ellipsis',
          }}
        >
          {subtitle}
        </div>
      )}
    </>
  );
}

export type LoginInputVisualState = 'default' | 'error';

/**
 * 固定国家码前缀几何(桌面 cn 手机号 +86 前缀块;MT-6)。figma 桌面国区节点未画
 * 前缀 UI(诊断书 §7.5 缺口),几何按桌面面板布局自洽、语义对齐移动端
 * LoginSkinPhoneInput(前缀不可点、输入框只承载 11 位本地号);设计补帧后以补帧为准。
 */
const PHONE_PREFIX = {
  /** 号码文本相对 §4.1 文本位(31)的额外让位:前缀"+86" 24px Bold ≈48px + 间距 18(对齐移动 marginRight)。 */
  reserve: 66,
} as const;

/**
 * 输入框(§4.1/§4.2:540×80 r40 #EEEEEE;default 边 #D4D4D4/focus·filled 边 #2A2828
 * 字转 Bold #252222/error 边 #D91F37;hover 黑 5% 叠层 = §2.2 延展照抄白按钮 347:2529)。
 * focus/filled 视觉由 CSS(:focus)与 value 是否非空驱动,error 由调用方传入。
 * prefix:固定前缀覆盖层(不可点、恒 Bold 墨色,如 cn 手机号 "+86"),文本区右移让位。
 */
export function LoginInput({
  value,
  onChange,
  placeholder,
  disabled,
  error,
  center,
  type,
  autoComplete,
  inputMode,
  maxLength,
  pattern,
  autoFocus,
  top = CONTROL.inputY,
  prefix,
  testId,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  disabled?: boolean;
  error?: boolean;
  /** 验证码变体:文本居中(§4.2) */
  center?: boolean;
  type?: string;
  autoComplete?: string;
  inputMode?: 'numeric' | 'text' | 'tel' | 'email';
  maxLength?: number;
  pattern?: string;
  autoFocus?: boolean;
  top?: number;
  /** 固定前缀块文本(仅左对齐形态;undefined = 无前缀,布局与旧版逐字节一致)。 */
  prefix?: string;
  testId?: string;
}) {
  const filled = value.length > 0;
  const prefixNode = prefix != null && !center && (
    <span
      aria-hidden
      data-testid="login-input-prefix"
      className="pointer-events-none absolute z-[1] select-none"
      style={{
        left: CONTROL.x + CONTROL.textPadLeft,
        top,
        height: CONTROL.height,
        lineHeight: `${CONTROL.height}px`,
        fontSize: CONTROL.fontSize,
        fontWeight: 700,
        color: LOGIN_COLORS.controlText,
      }}
    >
      {prefix}
    </span>
  );
  return (
    <>
      {prefixNode}
      <input
        data-testid={testId ?? 'login-input'}
        autoFocus={autoFocus}
        disabled={disabled}
        type={type}
        autoComplete={autoComplete}
        inputMode={inputMode}
        maxLength={maxLength}
        pattern={pattern}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={cn(
          'absolute box-border appearance-none overflow-hidden whitespace-nowrap outline-none',
          'login-skin-input transition-none',
          // placeholder 接 token(figma §4.1 定稿值);漏接时被 Tailwind preflight
          // 默认 placeholder 灰顶替(2026-07-23 用户实测发现)。
          'placeholder:text-[var(--login-control-placeholder)]',
          // hover 黑 5% 叠层(§2.2 照抄 347:2529;input 无法用伪元素,叠 background-image)
          'hover:enabled:[background-image:linear-gradient(var(--login-overlay-input-hover),var(--login-overlay-input-hover))]',
          'disabled:cursor-not-allowed',
          center ? 'text-center' : 'text-left',
        )}
        style={
          {
            left: CONTROL.x,
            top,
            width: CONTROL.width,
            height: CONTROL.height,
            borderRadius: CONTROL.radius,
            background: LOGIN_COLORS.controlBg,
            border: `1px solid ${
              error
                ? LOGIN_COLORS.errorFg
                : filled
                  ? LOGIN_COLORS.controlBorderActive
                  : LOGIN_COLORS.controlBorder
            }`,
            paddingLeft: center
              ? 0
              : CONTROL.textPadLeft + (prefix != null ? PHONE_PREFIX.reserve : 0),
            fontSize: CONTROL.fontSize,
            fontWeight: filled || error ? 700 : 400,
            color: filled || error ? LOGIN_COLORS.controlText : LOGIN_COLORS.controlPlaceholder,
            // focus 态(#2A2828 边)由全局无法内联表达的 :focus 承载 → CSS var 交给
            // style 层:用 outline:none + onFocus/blur 会引入布局态;此处用
            // CSS 自定义属性 + 下方 <style> 惯例过重,直接以 box-shadow 承载 focus 边。
            ['--login-input-active-border' as string]: LOGIN_COLORS.controlBorderActive,
          } as CSSProperties
        }
        onFocus={(event) => {
          if (!error) event.currentTarget.style.borderColor = LOGIN_COLORS.controlBorderActive;
          event.currentTarget.style.fontWeight = '700';
          event.currentTarget.style.color = LOGIN_COLORS.controlText;
        }}
        onBlur={(event) => {
          const nowFilled = event.currentTarget.value.length > 0;
          event.currentTarget.style.borderColor = error
            ? LOGIN_COLORS.errorFg
            : nowFilled
              ? LOGIN_COLORS.controlBorderActive
              : LOGIN_COLORS.controlBorder;
          event.currentTarget.style.fontWeight = nowFilled ? '700' : '400';
          event.currentTarget.style.color = nowFilled
            ? LOGIN_COLORS.controlText
            : LOGIN_COLORS.controlPlaceholder;
        }}
      />
    </>
  );
}

/**
 * 主按钮(§4.3 五态:normal/hover 白 8%/pressed 黑 50%/loading spinner 24@(487,27)/
 * disabled 白 70% 叠层+边 #B4B4B4+文字 80%)。文字保持居中,spinner 绝对定位。
 */
export function LoginPrimaryButton({
  children,
  onClick,
  disabled,
  loading,
  top = CONTROL.buttonY,
  type = 'button',
  testId,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
  top?: number;
  type?: 'button' | 'submit';
  testId?: string;
}) {
  const inert = disabled || loading;
  return (
    <button
      data-testid={testId ?? 'login-primary-button'}
      type={type}
      // loading 也阻断交互(含 form submit),但 disabled 视觉只跟 disabled prop(§4.3 五态互斥)
      disabled={inert}
      onClick={loading ? undefined : onClick}
      className={cn(
        'absolute box-border flex items-center justify-center overflow-hidden font-bold',
        overlayBase,
        !inert &&
          'hover:after:opacity-100 hover:after:bg-[var(--login-overlay-button-hover)] active:after:bg-[var(--login-overlay-button-pressed)] active:after:opacity-100',
        loading && 'cursor-default',
        disabled &&
          'cursor-not-allowed after:opacity-100 after:[background:var(--login-disabled-button-overlay)]',
      )}
      style={{
        left: CONTROL.x,
        top,
        width: CONTROL.width,
        height: CONTROL.height,
        borderRadius: CONTROL.radius,
        // disabled 底/字两模式同构(深底浅字,暗色不随 primaryButtonBg 反相为白;
        // figma white_button Disable:深底 + 白 70% 叠层 + disabled 边 + 字 80%)
        background: disabled ? LOGIN_COLORS.disabledButtonBg : LOGIN_COLORS.primaryButtonBg,
        border: `1px solid ${disabled ? LOGIN_COLORS.controlBorderDisabled : LOGIN_COLORS.primaryButtonBorder}`,
        color: disabled ? LOGIN_COLORS.disabledButtonText : LOGIN_COLORS.primaryButtonText,
        fontSize: CONTROL.fontSize,
        opacity: 1,
      }}
    >
      <span className={cn('relative z-[1]', disabled && 'opacity-80')}>{children}</span>
      {loading && (
        <span
          role="status"
          className="absolute z-[1] inline-flex animate-spin motion-reduce:animate-none"
          style={{ left: SPINNER.x, top: SPINNER.y, width: SPINNER.size, height: SPINNER.size }}
        >
          <LoginSpinnerGlyph size={SPINNER.size} />
        </span>
      )}
    </button>
  );
}

/** spinner 图形(静态 SVG,动画由外层 wrapper 承载——规则 7)。 */
function LoginSpinnerGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke={LOGIN_COLORS.primaryButtonText}
        strokeOpacity="0.25"
        strokeWidth="3"
      />
      <path
        d="M22 12a10 10 0 0 0-10-10"
        stroke={LOGIN_COLORS.primaryButtonText}
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * 第三方圆钮行(§4.5:80×80 r50 #2A2828/#434343,icon 48,gap 70,y=480;
 * 行内水平居中 = demo socialRow left 公式)。SSO = 行内最后一颗(329:243)。
 */
export function LoginSocialRow({ children, count }: { children: ReactNode; count: number }) {
  const left = Math.max(
    0,
    (PANEL.width - (count * SOCIAL.size + Math.max(0, count - 1) * SOCIAL.gap)) / 2,
  );
  return (
    <div
      data-testid="login-social-row"
      className="absolute flex"
      style={{ left, top: SOCIAL.y, height: SOCIAL.size, gap: SOCIAL.gap }}
    >
      {children}
    </div>
  );
}

/**
 * 第三方圆钮(§4.5:80×80 r50 #2A2828/#434343,icon 48 居中)。
 *
 * 态系(§10 拍板 2026-07-21):仅 normal + hover(仅桌面)+ pressed(双端)三态,
 * hover/pressed 叠层照抄主按钮(白 8% / 黑 50% rgba,§2.2);**无 disabled / loading 态**
 * (用户 2026-07-21 拍板移除,覆盖 §2.2 表 2026-07-19 loading/disabled 两行;圆钮从不曾
 * 实现 loading,disabled 渲染路径本轮删除)。normal 底色/描边走主题 token
 * (primaryButtonBg / primaryButtonBorder);hover/pressed 叠层为 figma §2.1 实测 rgba
 * 字面参数(与主按钮同款,非主题色——token-decision-table §3)。主按钮五态不受影响。
 */
export function LoginSocialButton({
  label,
  onClick,
  children,
  testId,
  isLoading,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  testId?: string;
  /**
   * in-flight 态(登录发起中):仅输出 `aria-disabled` 无障碍语义,不传原生 `disabled`——
   * 圆钮无 disabled 视觉态(§10 拍板 2026-07-21 移除 loading/disabled 态),视觉/交互态不变;
   * 交互 guard 由调用方 onClick 闭包兜(见 LoginPage SC-SOC-7:`if (isLoading) return`),
   * 与本组件对称的移动端 LoginSkinButton `accessibilityState={{ busy }}` 语义一致。
   */
  isLoading?: boolean;
}) {
  return (
    <button
      data-testid={testId}
      type="button"
      title={label}
      aria-label={label}
      // 无障碍语义:in-flight 时标 aria-disabled(对齐移动端 accessibilityState.busy);
      // 不传原生 disabled——圆钮无 disabled 视觉态(§10 拍板),视觉/交互态不变。
      aria-disabled={isLoading}
      onClick={onClick}
      className={cn(
        'relative grid place-items-center overflow-hidden',
        overlayBase,
        // hover(仅桌面)/pressed(双端)照抄主按钮(§2.2;白 8% / 黑 50% rgba 叠层)。
        'hover:after:opacity-100 hover:after:bg-[var(--login-overlay-button-hover)] active:after:bg-[var(--login-overlay-button-pressed)] active:after:opacity-100',
      )}
      style={{
        width: SOCIAL.size,
        height: SOCIAL.size,
        borderRadius: SOCIAL.radius,
        background: LOGIN_COLORS.primaryButtonBg,
        border: `1px solid ${LOGIN_COLORS.primaryButtonBorder}`,
      }}
    >
      <span
        className="z-[1] inline-flex"
        style={{ width: SOCIAL.iconSize, height: SOCIAL.iconSize }}
      >
        {children}
      </span>
    </button>
  );
}

/**
 * 返回按钮(§4.6:60×60 r40 #EEEEEE/边 #FFFFFF;hover 白 70%/pressed 黑 8%;
 * icon 24 box,chevron 视觉按设计稿方向)。
 */
export function LoginBackButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      data-testid="login-back-button"
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'absolute z-[2] grid place-items-center overflow-hidden',
        overlayBase,
        'hover:after:opacity-100 hover:after:bg-[var(--login-overlay-back-hover)] active:after:bg-[var(--login-overlay-back-pressed)] active:after:opacity-100',
        'disabled:cursor-not-allowed',
      )}
      style={{
        left: BACK.x,
        top: BACK.y,
        width: BACK.size,
        height: BACK.size,
        borderRadius: BACK.radius,
        background: LOGIN_COLORS.actionControlBg,
        border: `1px solid ${LOGIN_COLORS.backBorder}`,
      }}
    >
      {/* 24 box 内左向 chevron(247:1635 icon 语义;矢量重绘,静态) */}
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M14.5 5.5 8 12l6.5 6.5"
          stroke={LOGIN_COLORS.controlText}
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/**
 * Text_link(§4.7 状态表 + U-9 裁决):(70,238) 540×50 Regular 20 居中。
 * - link:default #2A2828 underline(247:1612)/hover #4A4848(358:792,仅桌面)/
 *   pressed #1A1818(U-9,--login-link-pressed;underline·字号·字重不变);
 * - countdown/info 变体:#D4D4D4 无 underline 不可交互(247:1614);
 *   binding code 子态「验证码已发送至 X」提示复用本变体(demo bindingPanel)。
 * 色变全走 CSS 类(hover:/active:),不改布局(design §2.3-1)。
 */
export function LoginTextLink({
  children,
  onClick,
  disabled,
  variant = 'link',
  top = TEXT_LINK.y,
  height = TEXT_LINK.height,
  testId,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  /** link = 可点击重发链接;countdown = 倒计时/提示文本(不可交互) */
  variant?: 'link' | 'countdown';
  top?: number;
  height?: number;
  testId?: string;
}) {
  const geometry: CSSProperties = {
    left: TEXT_LINK.x,
    top,
    width: TEXT_LINK.width,
    height,
    fontSize: TEXT_LINK.fontSize,
    fontWeight: 400,
  };
  if (variant === 'countdown') {
    return (
      <span
        data-testid={testId ?? 'login-text-link-countdown'}
        className="absolute flex items-center justify-center overflow-hidden whitespace-nowrap"
        style={{ ...geometry, color: LOGIN_COLORS.controlPlaceholder, textOverflow: 'ellipsis' }}
      >
        {children}
      </span>
    );
  }
  return (
    <button
      data-testid={testId ?? 'login-text-link'}
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'absolute flex items-center justify-center border-0 bg-transparent p-0 underline',
        'hover:enabled:[color:var(--login-link-hover)] active:enabled:[color:var(--login-link-pressed)]',
        'disabled:cursor-not-allowed',
      )}
      style={{ ...geometry, color: LOGIN_COLORS.linkText }}
    >
      {children}
    </button>
  );
}

/** 错误提示文本(§4.8:680×50 @(0,380) 20 Regular #D91F37 居中)。 */
export function LoginErrorText({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      data-testid="login-error-text"
      className="absolute left-0 flex items-center justify-center text-center"
      style={{
        top: ERROR_TEXT.y,
        width: ERROR_TEXT.width,
        height: ERROR_TEXT.height,
        fontSize: ERROR_TEXT.fontSize,
        color: LOGIN_COLORS.errorFg,
      }}
    >
      {children}
    </div>
  );
}

/**
 * 方式行(§4.9:540×100 r60 #EEEEEE/#D4D4D4;标题 24 Bold/副行 20 #6F6F6F 左对齐
 * x=67,文字块垂直居中行距 5;左 icon 24 box @(27,37)/person 18×20 @(30,39);
 * 右 share 18×18 @(490,40);hover 白 8%/pressed 黑 8%)。
 */
export function LoginMethodRow({
  top,
  title,
  subtitle,
  onClick,
  disabled,
  icon = 'enterprise',
  logoUrl,
  testId,
}: {
  top: number;
  title: string;
  subtitle?: string;
  onClick: () => void;
  disabled?: boolean;
  icon?: 'enterprise' | 'person';
  /** 企业 logo(auth console 上传);加载失败或缺省时回落到矢量 icon。 */
  logoUrl?: string | null;
  testId?: string;
}) {
  const [logoBroken, setLogoBroken] = useState(false);
  // 换 logo 后给新地址重试机会,不让一次加载失败钉死在矢量图标兜底上
  useEffect(() => {
    setLogoBroken(false);
  }, [logoUrl]);
  const showLogo = Boolean(logoUrl) && !logoBroken;
  return (
    <button
      data-testid={testId ?? 'login-method-row'}
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'absolute overflow-hidden',
        overlayBase,
        'hover:after:opacity-100 hover:after:bg-[var(--login-overlay-row-hover)] active:after:bg-[var(--login-overlay-row-pressed)] active:after:opacity-100',
        'disabled:cursor-not-allowed',
      )}
      style={{
        left: METHOD_ROW.x,
        top,
        width: METHOD_ROW.width,
        height: METHOD_ROW.height,
        borderRadius: METHOD_ROW.radius,
        border: `1px solid ${LOGIN_COLORS.controlBorder}`,
        background: LOGIN_COLORS.actionControlBg,
      }}
    >
      <span
        aria-hidden
        className="absolute inline-flex"
        style={
          !showLogo && icon === 'person'
            ? {
                left: METHOD_ROW.personIcon.x,
                top: METHOD_ROW.personIcon.y,
                width: METHOD_ROW.personIcon.width,
                height: METHOD_ROW.personIcon.height,
              }
            : {
                left: METHOD_ROW.leftIcon.x,
                top: METHOD_ROW.leftIcon.y,
                width: METHOD_ROW.leftIcon.size,
                height: METHOD_ROW.leftIcon.size,
              }
        }
      >
        {showLogo ? (
          <img
            src={logoUrl ?? undefined}
            alt=""
            draggable={false}
            onError={() => setLogoBroken(true)}
            className="h-full w-full rounded-lg object-cover"
          />
        ) : icon === 'person' ? (
          <PersonIcon />
        ) : (
          <EnterpriseIcon />
        )}
      </span>
      <span
        className="absolute flex flex-col justify-center text-left"
        style={{
          left: METHOD_ROW.textX,
          top: 0,
          height: '100%',
          width: METHOD_ROW.textWidth,
          gap: 5,
        }}
      >
        <span
          className="truncate font-bold"
          style={{ fontSize: 24, color: LOGIN_COLORS.controlText }}
        >
          {title}
        </span>
        {subtitle && (
          <span className="truncate" style={{ fontSize: 20, color: LOGIN_COLORS.secondaryText }}>
            {subtitle}
          </span>
        )}
      </span>
      <span
        aria-hidden
        className="absolute inline-flex"
        style={{
          left: METHOD_ROW.rightIcon.x,
          top: METHOD_ROW.rightIcon.y,
          width: METHOD_ROW.rightIcon.size,
          height: METHOD_ROW.rightIcon.size,
        }}
      >
        <ShareIcon />
      </span>
    </button>
  );
}

/**
 * 大 loading 环(figma §5.2:64×64 @(308,158/193),内弧深色;demo .loading-big)。
 * 动画 = transform 旋转挂 HTML div(compositor-only);reduced-motion 直落静止。
 */
export function LoginLoadingRing({ y, label }: { y: number; label: string }) {
  return (
    <span
      role="status"
      aria-label={label}
      className="absolute inline-flex animate-spin rounded-full motion-reduce:animate-none"
      style={{
        left: LOADING_RING.x,
        top: y,
        width: LOADING_RING.size,
        height: LOADING_RING.size,
        border: '6px solid var(--login-loading-ring-track)',
        borderTopColor: LOGIN_COLORS.primaryButtonBg,
      }}
    />
  );
}

/* ── 方式行图标(figma 资产 carbon:enterprise / person / icon-park:share 矢量,
      源 = 设计稿导出 SVG path 内联;fill/stroke 收敛到 token) ── */

function EnterpriseIcon() {
  return (
    <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 6H7.5V9H6V6ZM6 10.5H7.5V13.5H6V10.5ZM10.5 6H12V9H10.5V6ZM10.5 10.5H12V13.5H10.5V10.5ZM6 15H7.5V18H6V15ZM10.5 15H12V18H10.5V15Z"
        fill={LOGIN_COLORS.controlText}
      />
      <path
        d="M22.5 10.5C22.5 10.1022 22.342 9.72064 22.0607 9.43934C21.7794 9.15804 21.3978 9 21 9H16.5V3C16.5 2.60218 16.342 2.22064 16.0607 1.93934C15.7794 1.65804 15.3978 1.5 15 1.5H3C2.60218 1.5 2.22064 1.65804 1.93934 1.93934C1.65804 2.22064 1.5 2.60218 1.5 3V22.5H22.5V10.5ZM3 3H15V21H3V3ZM16.5 21V10.5H21V21H16.5Z"
        fill={LOGIN_COLORS.controlText}
      />
    </svg>
  );
}

function PersonIcon() {
  return (
    <svg width="100%" height="100%" viewBox="0 0 18 20" fill="none" aria-hidden>
      <path
        d="M9 10C11.76 10 14 7.76 14 5C14 2.24 11.76 0 9 0C6.24 0 4 2.24 4 5C4 7.76 6.24 10 9 10ZM9 2C10.65 2 12 3.35 12 5C12 6.65 10.65 8 9 8C7.35 8 6 6.65 6 5C6 3.35 7.35 2 9 2ZM1 20H17C17.55 20 18 19.55 18 19V18C18 14.14 14.86 11 11 11H7C3.14 11 0 14.14 0 18V19C0 19.55 0.45 20 1 20ZM7 13H11C13.76 13 16 15.24 16 18H2C2 15.24 4.24 13 7 13Z"
        fill={LOGIN_COLORS.controlText}
      />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg width="100%" height="100%" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d="M12 1H19V8"
        stroke={LOGIN_COLORS.controlText}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M19 12.7368V17.5C19 18.3285 18.3285 19 17.5 19H2.5C1.67158 19 1 18.3285 1 17.5V2.5C1 1.67158 1.67158 1 2.5 1H7"
        stroke={LOGIN_COLORS.controlText}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10.8999 9.09995L18.5499 1.44995"
        stroke={LOGIN_COLORS.controlText}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
