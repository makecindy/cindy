import { useEffect, useRef, useState } from 'react';
import type {
  CSSProperties,
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from 'react';

import { cn } from '@/lib/utils';

import { PANEL_FIXED_SCALE } from './loginScale';
import {
  BACK,
  CONSENT_DIALOG,
  CONSENT_ROW,
  CONTROL,
  ERROR_TEXT,
  LOADING_RING,
  LOGIN_COLORS,
  METHOD_ROW,
  PANEL,
  REGION_PILL,
  SKIP_ENTRY,
  SOCIAL,
  SPINNER,
  SSO_ORG_HISTORY,
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

/**
 * 面板(680×500 r36 + wave4 1px inside 描边 368:1383)。
 *
 * height 默认取 PANEL.height(登录全步骤共用,恒定不跳变);仅 Splash 借用本组件时
 * 传 SPLASH_PANEL.height 保持 440(见 loginDesignTokens SPLASH_PANEL 注释)。
 */
export function LoginPanel({
  children,
  testId,
  height = PANEL.height,
}: {
  children: ReactNode;
  testId?: string;
  /** 面板高度覆写(设计px);仅 Splash 使用,登录侧一律用默认值。 */
  height?: number;
}) {
  return (
    <div
      data-testid={testId ?? 'login-panel'}
      className="absolute left-0 top-0 overflow-hidden"
      style={{
        width: PANEL.width,
        height,
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
 * 标题块(figma §5.1:标题 y=31 h=38 32 Bold;副标题 @(70,75) 540 宽 ≤2 行顶对齐
 * 20 Regular——2026-07-24 拍板,原 figma 单行 599@41 作废,见 DESIGN.md §16.2)。
 * 区域徽标变体(v2 inline 组,用户裁定 2026-07-25):标题 shrink-to-fit 单行 + 徽标
 * 紧随其后 gap 2 设计px,组整体相对面板水平居中;原 v1 固定几何(span @185 w236 +
 * pill @425,4)作废,见 DESIGN.md §16.2 与 figma-component-spec §4.10 的 v2 批注。
 * 徽标挂哪些区域由调用方决定(2026-07-27 起 global 不挂,见 LoginPage)。
 */
export function LoginTitleBlock({
  title,
  subtitle,
  regionPill,
  subtitleMaxLines = SUBTITLE.maxLines,
}: {
  title: string;
  subtitle?: ReactNode;
  /** 区域徽标文案(如 CN / Dev);省略即不挂徽标。 */
  regionPill?: string;
  /** 副标题行数上限(登录屏默认 2;Splash 故障指引等长文案宿主可放宽)。 */
  subtitleMaxLines?: number;
}) {
  return (
    <>
      <div
        className="absolute left-0 whitespace-nowrap text-center font-bold"
        style={{
          top: TITLE.y,
          width: PANEL.width,
          height: TITLE.height,
          // 行框 = 设计 h(38 @32):缺省行高继承 body 1.5(≈48px)>容器 38,显式
          // lineHeight=行框高保几何忠实、拉丁 descender 完整(MT-7;与回调页 h1
          // line-height:38px、移动端 LoginTitleBlock 同款)。不设 overflow-hidden /
          // ellipsis:登录链路裁切与省略号不可作为可见结果(DESIGN.md §16.2,
          // 2026-07-24 拍板)——超宽属文案预算 bug,修文案不裁布局。
          lineHeight: `${TITLE.height}px`,
          fontSize: TITLE.fontSize,
          color: LOGIN_COLORS.titleText,
        }}
      >
        {regionPill ? (
          // inline 组(用户裁定 2026-07-25):标题 shrink-to-fit 单行 + 徽标紧随
          // gap 2 设计px,组整体随外层 text-center 相对面板水平居中;徽标垂直
          // 居中于 38 行框(等价旧 top:4)。align-top 抵消 inline-flex 默认
          // baseline 对齐带来的行框偏移。
          <span
            className="inline-flex max-w-full items-center justify-center whitespace-nowrap align-top"
            style={{ gap: REGION_PILL.gap, height: TITLE.height }}
          >
            <span className="whitespace-nowrap">{title}</span>
            <span
              data-testid="login-region-pill"
              // 宽度由 padding 撑开(见 REGION_PILL doc):徽标文案随区域变化,
              // 固定宽只对 "Global" 成立。shrink-0 保证标题超长时先挤标题不挤徽标。
              className="shrink-0 text-center font-bold"
              style={{
                height: REGION_PILL.height,
                paddingLeft: REGION_PILL.paddingX,
                paddingRight: REGION_PILL.paddingX,
                borderRadius: REGION_PILL.radius,
                background: LOGIN_COLORS.brandAccent,
                color: LOGIN_COLORS.invertedButtonBorder,
                fontSize: REGION_PILL.fontSize,
                lineHeight: `${REGION_PILL.height}px`,
              }}
            >
              {regionPill}
            </span>
          </span>
        ) : (
          title
        )}
      </div>
      {subtitle != null && (
        <div
          // break-words:codeSentTo 邮箱、org slug 等无空格长 token 需要词内断行
          // 才能用上第二行,否则单行横向溢出被裁。
          className="absolute overflow-hidden break-words text-center [display:-webkit-box] [-webkit-box-orient:vertical]"
          style={{
            left: SUBTITLE.x,
            top: SUBTITLE.y,
            width: SUBTITLE.width,
            height: SUBTITLE.lineHeight * subtitleMaxLines,
            // 显式行高:继承行高(body 1.5)大于槽高会被 clamp 裁字形(MT-7)。
            lineHeight: `${SUBTITLE.lineHeight}px`,
            fontSize: SUBTITLE.fontSize,
            color: LOGIN_COLORS.secondaryText,
            WebkitLineClamp: subtitleMaxLines,
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
  onFocus,
  onBlur,
  onClick,
  onKeyDown,
  role,
  ariaControls,
  ariaExpanded,
  ariaActiveDescendant,
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
  onFocus?: (event: ReactFocusEvent<HTMLInputElement>) => void;
  onBlur?: (event: ReactFocusEvent<HTMLInputElement>) => void;
  onClick?: (event: ReactMouseEvent<HTMLInputElement>) => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  role?: 'combobox';
  ariaControls?: string;
  ariaExpanded?: boolean;
  ariaActiveDescendant?: string;
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
        onClick={onClick}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        role={role}
        aria-autocomplete={role === 'combobox' ? 'list' : undefined}
        aria-controls={ariaControls}
        aria-expanded={ariaExpanded}
        aria-activedescendant={ariaActiveDescendant}
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
          onFocus?.(event);
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
          onBlur?.(event);
        }}
      />
    </>
  );
}

export function ssoOrgHistoryOptionId(index: number): string {
  return `login-sso-org-history-option-${index}`;
}

/** Visual-only listbox for recent successful organization identifiers. */
export function LoginSsoOrgHistoryList({
  entries,
  value,
  activeIndex,
  onActiveIndexChange,
  onSelect,
  listId,
}: {
  entries: readonly string[];
  value: string;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onSelect: (entry: string) => void;
  listId: string;
}) {
  const selectedKey = value.trim().toLowerCase();
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    if (activeIndex < 0) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);
  return (
    <div
      id={listId}
      data-testid="login-sso-org-history-list"
      role="listbox"
      className="absolute z-[4] box-border overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{
        left: SSO_ORG_HISTORY.x,
        top: SSO_ORG_HISTORY.y,
        width: SSO_ORG_HISTORY.width,
        maxHeight: SSO_ORG_HISTORY.maxHeight,
        borderRadius: SSO_ORG_HISTORY.radius,
        background: LOGIN_COLORS.panelBg,
        border: `1px solid ${LOGIN_COLORS.controlBorder}`,
      }}
    >
      {entries.map((entry, index) => {
        const highlighted = activeIndex === index || entry.toLowerCase() === selectedKey;
        return (
          <button
            id={ssoOrgHistoryOptionId(index)}
            key={entry.toLowerCase()}
            ref={(node) => {
              optionRefs.current[index] = node;
            }}
            type="button"
            role="option"
            aria-selected={entry.toLowerCase() === selectedKey}
            data-testid={`login-sso-org-history-option-${index}`}
            tabIndex={-1}
            className="flex w-full items-center border-0 text-left hover:bg-[var(--login-action-control-bg)]"
            style={{
              minHeight: SSO_ORG_HISTORY.rowMinHeight,
              paddingLeft: SSO_ORG_HISTORY.paddingX,
              paddingRight: SSO_ORG_HISTORY.paddingX,
              paddingTop: SSO_ORG_HISTORY.paddingY,
              paddingBottom: SSO_ORG_HISTORY.paddingY,
              borderRadius: SSO_ORG_HISTORY.rowRadius,
              background: highlighted ? LOGIN_COLORS.actionControlBg : 'transparent',
              color: LOGIN_COLORS.controlText,
              fontSize: SSO_ORG_HISTORY.fontSize,
              lineHeight: `${SSO_ORG_HISTORY.lineHeight}px`,
              overflowWrap: 'anywhere',
            }}
            onMouseEnter={() => onActiveIndexChange(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(entry)}
          >
            {entry}
          </button>
        );
      })}
    </div>
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
 * 第三方圆钮行(§4.5:80×80 r50 #2A2828/#434343,icon 48,gap 70,y=540 = 面板底 +40;
 * 行内水平居中 = demo socialRow left 公式)。SSO = 行内最后一颗(游客圆钮已随
 * 「跳过登录」文字入口移入面板内而删除)。
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
  variant = 'default',
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
  /**
   * apple = Apple 登录专属样式(App Store Guideline 4,用户标准图 2026-07-24):
   * 亮色黑圆(ADR Black button)/ 暗色白圆(ADR White button),无描边;
   * 其余圆钮维持 primaryButton 反相底 + 1px 描边。
   */
  variant?: 'default' | 'apple';
}) {
  const isApple = variant === 'apple';
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
        background: isApple ? LOGIN_COLORS.appleCircleBg : LOGIN_COLORS.primaryButtonBg,
        border: isApple ? 'none' : `1px solid ${LOGIN_COLORS.primaryButtonBorder}`,
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
 *
 * ⚠ 与「跳过登录」文字**按钮**(LoginSkipEntry)是两种组件:本组件是文字**链接**
 * (hover/pressed 变色 link 族语义),跳过登录不变色、自适应热区,不要混用。
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

/**
 * 「跳过登录」文字按钮(新稿容器 705:1068/700:910;用户拍板 2026-07-27)。
 *
 * **与 LoginTextLink 是两种组件**:那个是文字链接(link 族 hover/pressed 变色),
 * 本组件是文字按钮——颜色 light/dark 统一 `--login-secondary-text`(#6F6F6F 双模同值),
 * hover/pressed **不变色**,只靠下划线与指针形状给反馈。
 *
 * 热区(用户拍板):**不全宽**。680×60(SKIP_ENTRY)只是布局容器且自身不可点
 * (pointer-events:none),真正可点的是内层 button = 当前语言实际文字渲染宽度
 * + 左右各 30 设计px(hitPaddingX,shrink-to-fit 随语言自适应),高度占满 60 槽;
 * 文字仍相对 680 容器水平居中(容器 justify-center + button 左右 padding 对称)。
 */
export function LoginSkipEntry({
  children,
  onClick,
  disabled,
  testId,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <div
      data-testid="login-skip-entry-slot"
      className="absolute flex items-center justify-center"
      style={{
        left: SKIP_ENTRY.x,
        top: SKIP_ENTRY.y,
        width: SKIP_ENTRY.width,
        height: SKIP_ENTRY.height,
        // 容器只负责居中定位,不承接点击:热区收敛到内层 button(用户拍板 2026-07-27)
        pointerEvents: 'none',
      }}
    >
      <button
        data-testid={testId ?? 'login-skip-entry'}
        type="button"
        disabled={disabled}
        onClick={onClick}
        className={cn(
          'flex items-center justify-center overflow-hidden whitespace-nowrap',
          'border-0 bg-transparent underline',
          'cursor-pointer disabled:cursor-not-allowed',
        )}
        style={{
          // 宽度不写死:shrink-to-fit 文字宽 + 左右 hitPaddingX,随语言自适应
          height: SKIP_ENTRY.height,
          // 防御性上界(非设计许可,DESIGN.md 单行槽兜底):按钮含 padding 不越 680 容器,
          // 避免超长译文两侧被面板 overflow-hidden 静默裁掉。可见截断 = 文案 bug,改文案不改布局。
          maxWidth: SKIP_ENTRY.width,
          paddingLeft: SKIP_ENTRY.hitPaddingX,
          paddingRight: SKIP_ENTRY.hitPaddingX,
          fontSize: SKIP_ENTRY.fontSize,
          fontWeight: 400,
          color: LOGIN_COLORS.secondaryText,
          textOverflow: 'ellipsis',
          pointerEvents: 'auto',
        }}
      >
        {children}
      </button>
    </div>
  );
}

/* ── 协议同意族(consent PR;figma wave5 radiobutton 600:627 + 弹窗 602:822) ── */

export type LegalSegment = { kind: 'text' | 'terms' | 'privacy'; text: string };

/**
 * 解析协议文案里的内联链接标记(`<terms>…</terms>` / `<privacy>…</privacy>`)。
 * i18n 单 key 保住各语言词序(ja 链接前置、zh/en 链接居中),链接段由代码确定性
 * 拆分渲染(规则 9),不依赖 react-i18next Trans(仓内无此先例)。
 */
export function parseLegalSegments(input: string): LegalSegment[] {
  const out: LegalSegment[] = [];
  const re = /<(terms|privacy)>(.*?)<\/\1>/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input))) {
    if (match.index > last) out.push({ kind: 'text', text: input.slice(last, match.index) });
    out.push({ kind: match[1] as 'terms' | 'privacy', text: match[2] });
    last = match.index + match[0].length;
  }
  if (last < input.length) out.push({ kind: 'text', text: input.slice(last) });
  return out;
}

/**
 * 协议声明内联渲染:文本段原样、链接段 = Bold + underline 可点(600:661 span 样式;
 * 颜色继承所在容器,hover/pressed 走 Text_link 同源 token)。链接点击只开外部
 * 浏览器,不冒泡到 radio 切换。
 */
function LegalStatementText({
  statement,
  onOpenTerms,
  onOpenPrivacy,
  testIdPrefix,
}: {
  statement: string;
  onOpenTerms: () => void;
  onOpenPrivacy: () => void;
  testIdPrefix: string;
}) {
  return (
    <>
      {parseLegalSegments(statement).map((segment, index) => {
        if (segment.kind === 'text') {
          // eslint-disable-next-line react/no-array-index-key
          return <span key={index}>{segment.text}</span>;
        }
        const isTerms = segment.kind === 'terms';
        return (
          <button
            // eslint-disable-next-line react/no-array-index-key
            key={index}
            type="button"
            data-testid={`${testIdPrefix}-${segment.kind}-link`}
            onClick={(event) => {
              event.stopPropagation();
              (isTerms ? onOpenTerms : onOpenPrivacy)();
            }}
            className={cn(
              'inline border-0 bg-transparent p-0 font-bold underline',
              'transition-colors duration-[var(--motion-fast,150ms)]',
              'hover:[color:var(--login-link-hover)] active:[color:var(--login-link-pressed)]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
            )}
            style={{ font: 'inherit', fontWeight: 700, color: 'inherit', cursor: 'pointer' }}
          >
            {segment.text}
          </button>
        );
      })}
    </>
  );
}

/** radio 选中对勾(figma 600:632 Group:8.65×5.13 @(8.35,10) stroke 3 round;静态矢量)。 */
function ConsentCheckGlyph() {
  const s = CONSENT_ROW.radio.ringSize;
  return (
    <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} fill="none" aria-hidden>
      {/* 圈体坐标系 20×20(命中区 24 内缩 2):勾形按 24 系 (8.35,10)-(17,15.13) 平移 -2 */}
      <path
        d="M6.6 10.4 L9.3 12.9 L15 8.2"
        stroke={LOGIN_COLORS.consentRadioCheck}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * 协议同意行(figma 600:660:登录组下方 22 设计px,680×40,内容水平居中):
 * radio(24 命中区,圈 20 r9 + 2px 描边,选中态对勾)+ 声明文字 20 Regular
 * (login-control-text 双态),「服务条款」「隐私协议」为 Bold underline 内联链接。
 * radio 态切换只变圈色(transition-colors ≤150ms,规则 7:无布局跳变)。
 *
 * **整行热区**(2026-07-29 拍板):680×40 整行都能点,点声明文字与行内空白都等于
 * 点 radio——原来只有 24px 圈体可点,鼠标要瞄准一个小圆点。两类元素例外:
 * 「服务条款」/「隐私协议」两个内联链接各自 stopPropagation(点它们只开链接,
 * 不切勾选态),radio 自己也 stopPropagation(否则冒泡到行容器会二次 toggle,
 * 净效果为不变)。行容器刻意不加 role/tabIndex:radio 仍是唯一的无障碍交互点
 * (role="checkbox" + aria-labelledby 指向声明文字),整行点击只是鼠标增强,
 * 不给读屏用户制造第二个语义相同的可聚焦节点。
 */
export function LoginConsentRow({
  checked,
  onToggle,
  statement,
  onOpenTerms,
  onOpenPrivacy,
}: {
  checked: boolean;
  onToggle: () => void;
  statement: string;
  onOpenTerms: () => void;
  onOpenPrivacy: () => void;
}) {
  const { hitSize, ringSize, ringRadius, ringStroke } = CONSENT_ROW.radio;
  return (
    <div
      data-testid="login-consent-row"
      // select-none:整行可点后,连点会选中声明文字,拖选也会盖住勾选反馈
      className="absolute left-0 flex select-none items-center justify-center"
      onClick={onToggle}
      style={{
        top: CONSENT_ROW.y,
        width: CONSENT_ROW.width,
        height: CONSENT_ROW.height,
        gap: CONSENT_ROW.gap,
        cursor: 'pointer',
      }}
    >
      <button
        data-testid="login-consent-radio"
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-labelledby="login-consent-statement"
        onClick={(event) => {
          // 行容器已接同一个 onToggle:不拦住冒泡会切两次,视觉上等于点不动
          event.stopPropagation();
          onToggle();
        }}
        className="grid shrink-0 place-items-center border-0 bg-transparent p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]"
        style={{ width: hitSize, height: hitSize, cursor: 'pointer' }}
      >
        <span
          className="grid place-items-center transition-colors duration-[var(--motion-fast,150ms)]"
          style={{
            width: ringSize,
            height: ringSize,
            borderRadius: ringRadius,
            background: checked ? LOGIN_COLORS.consentRadioCheckedBg : LOGIN_COLORS.consentRadioBg,
            boxShadow: `inset 0 0 0 ${ringStroke}px ${
              checked ? LOGIN_COLORS.consentRadioCheckedBg : LOGIN_COLORS.consentRadioBorder
            }`,
          }}
        >
          {checked && <ConsentCheckGlyph />}
        </span>
      </button>
      <span
        id="login-consent-statement"
        className="whitespace-nowrap"
        style={{
          fontSize: CONSENT_ROW.fontSize,
          lineHeight: '23px',
          color: LOGIN_COLORS.controlText,
        }}
      >
        <LegalStatementText
          statement={statement}
          onOpenTerms={onOpenTerms}
          onOpenPrivacy={onOpenPrivacy}
          testIdPrefix="login-consent"
        />
      </span>
    </div>
  );
}

/**
 * 服务条款弹窗(figma 602:822/602:1249):全屏遮罩黑 85% + 680×380 r36 面板
 * (login-panel-bg/border 双态复用),标题 Bold 32、正文 26/40(secondary-text,
 * 内联链接可点),两钮 260×80 r40——不同意 = 次级钮(wave5 双色小按钮),
 * 同意 = 强调钮(login-primary-button-* 复用)。
 * 交互:打开即焦点落「同意」,Tab/Shift+Tab 在弹窗内循环(focus trap),背景
 * 兄弟节点置 inert,关闭后焦点归还触发元素(DESIGN.md §14.2);Esc = 不同意;
 * 遮罩不可点穿(协议确认必须显式选择)。面板按恒定 0.5 缩放渲染(与登录面板
 * 同口径)。未复用 confirm-dialog.tsx:登录皮肤需要设计 px 绝对坐标 + 恒定缩放
 * + login-* token 全套,与通用确认弹窗结构不兼容,故按 §14.2 语义自绘等价实现。
 */
export function LoginConsentDialog({
  title,
  body,
  agreeLabel,
  disagreeLabel,
  onAgree,
  onDisagree,
  onOpenTerms,
  onOpenPrivacy,
}: {
  title: string;
  body: string;
  agreeLabel: string;
  disagreeLabel: string;
  onAgree: () => void;
  onDisagree: () => void;
  onOpenTerms: () => void;
  onOpenPrivacy: () => void;
}) {
  const agreeRef = useRef<HTMLButtonElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // 记录触发元素 → 打开聚焦「同意」→ 背景兄弟节点 inert(遮罩挡鼠标,
    // inert 挡键盘/读屏,与下方 Tab trap 构成完整模态)→ 关闭归还焦点(§14.2)
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    agreeRef.current?.focus();
    const rootEl = containerRef.current;
    const inerted: HTMLElement[] = [];
    if (rootEl?.parentElement) {
      for (const child of Array.from(rootEl.parentElement.children)) {
        if (child !== rootEl && child instanceof HTMLElement && !child.inert) {
          child.inert = true;
          inerted.push(child);
        }
      }
    }
    return () => {
      for (const el of inerted) el.inert = false;
      // 元素已随视图卸载时 focus() 为安全 no-op
      opener?.focus();
    };
  }, []);
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      onDisagree();
      return;
    }
    if (event.key !== 'Tab') return;
    // focus trap:Tab/Shift+Tab 在弹窗可聚焦元素间循环,不落入背景登录页
    const root = containerRef.current;
    if (!root) return;
    const focusables = Array.from(
      root.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !root.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last || !root.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  };
  const { button } = CONSENT_DIALOG;
  const smallButtonBase = cn(
    'absolute box-border flex items-center justify-center overflow-hidden font-bold',
    'after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit]',
    'after:opacity-0 after:transition-opacity after:duration-[var(--motion-fast,150ms)] after:content-[""]',
  );
  return (
    <div
      data-testid="login-consent-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="login-consent-dialog-title"
      aria-describedby="login-consent-dialog-body"
      ref={containerRef}
      // tabIndex=-1 + 遮罩点击回焦:点遮罩空白会让焦点落到 body,keydown 不再冒泡
      // 经容器,Esc 会短暂失效——点击遮罩自身时把焦点拉回容器,Esc 恒有效
      tabIndex={-1}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.focus();
      }}
      className="fixed inset-0 z-50 grid place-items-center outline-none"
      style={{ background: LOGIN_COLORS.consentOverlay }}
      onKeyDown={handleKeyDown}
    >
      <div
        className="relative"
        style={{
          width: CONSENT_DIALOG.width,
          height: CONSENT_DIALOG.height,
          borderRadius: CONSENT_DIALOG.radius,
          background: LOGIN_COLORS.panelBg,
          boxShadow: `inset 0 0 0 1px ${LOGIN_COLORS.panelBorder}`,
          transform: `scale(${PANEL_FIXED_SCALE})`,
        }}
      >
        <div
          id="login-consent-dialog-title"
          className="absolute left-0 whitespace-nowrap text-center font-bold"
          style={{
            top: CONSENT_DIALOG.title.y,
            width: CONSENT_DIALOG.width,
            height: CONSENT_DIALOG.title.height,
            lineHeight: `${CONSENT_DIALOG.title.height}px`,
            fontSize: CONSENT_DIALOG.title.fontSize,
            color: LOGIN_COLORS.titleText,
          }}
        >
          {title}
        </div>
        <div
          id="login-consent-dialog-body"
          className="absolute whitespace-pre-line text-center"
          style={{
            left: CONSENT_DIALOG.body.x,
            top: CONSENT_DIALOG.body.y,
            width: CONSENT_DIALOG.body.width,
            fontSize: CONSENT_DIALOG.body.fontSize,
            lineHeight: `${CONSENT_DIALOG.body.lineHeight}px`,
            color: LOGIN_COLORS.secondaryText,
          }}
        >
          <LegalStatementText
            statement={body}
            onOpenTerms={onOpenTerms}
            onOpenPrivacy={onOpenPrivacy}
            testIdPrefix="login-consent-dialog"
          />
        </div>
        <button
          data-testid="login-consent-disagree"
          type="button"
          onClick={onDisagree}
          className={cn(
            smallButtonBase,
            'hover:after:opacity-100 hover:after:bg-[var(--login-overlay-secondary-hover)]',
            'active:after:opacity-100 active:after:bg-[var(--login-overlay-secondary-pressed)]',
          )}
          style={{
            left: button.disagreeX,
            top: button.y,
            width: button.width,
            height: button.height,
            borderRadius: button.radius,
            fontSize: button.fontSize,
            background: LOGIN_COLORS.secondaryButtonBg,
            border: `1px solid ${LOGIN_COLORS.secondaryButtonBorder}`,
            color: LOGIN_COLORS.secondaryButtonText,
          }}
        >
          <span className="relative z-[1]">{disagreeLabel}</span>
        </button>
        <button
          ref={agreeRef}
          data-testid="login-consent-agree"
          type="button"
          onClick={onAgree}
          className={cn(
            smallButtonBase,
            'hover:after:opacity-100 hover:after:bg-[var(--login-overlay-button-hover)]',
            'active:after:opacity-100 active:after:bg-[var(--login-overlay-button-pressed)]',
          )}
          style={{
            left: button.agreeX,
            top: button.y,
            width: button.width,
            height: button.height,
            borderRadius: button.radius,
            fontSize: button.fontSize,
            background: LOGIN_COLORS.primaryButtonBg,
            border: `1px solid ${LOGIN_COLORS.primaryButtonBorder}`,
            color: LOGIN_COLORS.primaryButtonText,
          }}
        >
          <span className="relative z-[1]">{agreeLabel}</span>
        </button>
      </div>
    </div>
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
