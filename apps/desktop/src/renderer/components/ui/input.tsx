/**
 * Input —— DESIGN.md §4 单行输入标准控件，升格自 SettingsTextInput。
 *
 * 尺寸：sm/md/lg = 32/36/40px（DS-4 G1；输入框保留三档，按钮不设 40）。
 * 圆角：单行一律胶囊（§5）；textarea 变体一律 8px。
 * placeholder 一律 `--text-placeholder`（§4 G3）。
 *
 * `surface="ivory"` 是登记债（DS-4 G6，拍板人 = 用户/设计师，2026-09-03）：
 * colors.ts 的无文档漂移，仅供白弹窗面板场合。独立议题收口，本张不翻案。
 * API 原样搬：secret 眼睛显形、mono、trailing。
 *
 * FormField（label + 说明 + 错误行）首批调用点未用到，本张不建。
 */

import {
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
} from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

export type InputSize = 'sm' | 'md' | 'lg';
export type InputSurface = 'elevated' | 'ivory';

/**
 * 底色：默认 `elevated` = DESIGN.md §4 `input/text` 规定的 fill(`--surface-elevated`)。
 *
 * `ivory` 是给「输入压在白色弹窗面板上」的调用点保留的既有底色(`--settings-input-bg`,
 * 解析到 `--surface-card-ivory`)。这份 ivory 在设计文档里没有任何背书,属 colors.ts 的
 * 无文档漂移;它在白面板上能给出 fill 抬升,所以不在本 PR 里翻成白色,但也不能当默认——
 * settings 卡片本身就是 ivory(`--settings-theme-card-bg`),ivory 输入压在 ivory 卡上会和
 * 背景同色,填充对比度归零。settings 域这处 ivory / elevated 的收口是独立议题。
 */
const SURFACE_STYLES: Record<InputSurface, string> = {
  elevated: 'bg-[var(--surface-elevated)]',
  ivory: 'bg-[var(--settings-input-bg)]',
};

/** 各档的框体几何 + 无 trailing 时的右内边距（有 trailing 时统一让位给按钮）。 */
const SIZE_STYLES: Record<
  InputSize,
  { box: string; paddingLeft: string; paddingRight: string; trailingPaddingRight: string }
> = {
  sm: {
    box: 'h-8 text-12',
    paddingLeft: 'pl-3',
    paddingRight: 'pr-3',
    trailingPaddingRight: 'pr-8',
  },
  md: {
    box: 'h-9 text-13',
    paddingLeft: 'pl-4',
    paddingRight: 'pr-4',
    trailingPaddingRight: 'pr-9',
  },
  lg: {
    box: 'h-[40px] text-14',
    paddingLeft: 'pl-[12px]',
    paddingRight: 'pr-[12px]',
    trailingPaddingRight: 'pr-9',
  },
};

/** eye 按钮：小号框用小图标 / 更贴边，避免挤压 32px 行高。 */
const EYE_STYLES: Record<InputSize, { iconSize: number; offset: string }> = {
  sm: { iconSize: 14, offset: 'right-[10px]' },
  md: { iconSize: 16, offset: 'right-[12px]' },
  lg: { iconSize: 16, offset: 'right-[12px]' },
};

/**
 * 边框 / 文字 / placeholder 一律绑 Tier-1 slot，不继承 `--settings-input-*` 域 alias
 * （与 G5 对 button/secondary 的同一条判据：primitive 不继承域 alias，防设置页私有
 * 决定泄漏成全局默认）。这几个 alias 的默认值本就 forward-resolve 到同一批 slot，
 * 11 个内置主题与外部主题导入 allowlist 均未 override 它们，故默认外观逐值不变；
 * 变的是 override 面 —— 手写过 `settings-input-*` 的用户本地主题不再作用于本组件。
 * `--settings-input-border-focus` 亦同（其默认值 = `--text-tertiary-stone`）。
 */
const FIELD_CHROME =
  'text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] border border-[var(--border-default)] focus:border-[var(--text-tertiary-stone)] focus:ring-2 focus:ring-[var(--focus-ring)]';

const ERROR_CHROME =
  'border-[var(--error-border)] focus:border-[var(--error-fg)] focus:ring-[var(--error-fg)]';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'onChange'> {
  value: string;
  onChange: (v: string) => void;
  /** 绛兼潵鍏ョ粍浠剁殑 DOM input锛屼緥濡傝缃紑绐楃殑深链 focus。 */
  inputRef?: Ref<HTMLInputElement>;
  /** 兼容 SettingsTextInput 的可读名称别名，映射为原生 aria-label。 */
  ariaLabel?: string;
  size?: InputSize;
  /** 底色档:默认 §4 规定的 `--surface-elevated`;`ivory` 见 SURFACE_STYLES 注释。 */
  surface?: InputSurface;
  /** 等宽字体——密钥、ID 这类需要逐字核对的值。 */
  mono?: boolean;
  /** 密钥字段：遮罩输入 + 自带明文切换按钮。`secret` 为真时由组件接管 type。 */
  secret?: boolean;
  /** 自定义尾随元素（需自行绝对定位）。`secret` 优先，两者不叠加。 */
  trailing?: ReactNode;
  /** 错误态：边框 / focus 环切到 `--error-*` 族。 */
  error?: boolean;
  /** 附加到**外层容器**（内层 input 恒为 w-full），供 flex 行传 `flex-1 min-w-0`。 */
  className?: string;
}

export function Input({
  value,
  onChange,
  onBlur,
  placeholder,
  type = 'text',
  size = 'lg',
  surface = 'elevated',
  mono = false,
  secret = false,
  trailing,
  error = false,
  className,
  disabled,
  autoComplete,
  spellCheck,
  style,
  inputRef,
  ariaLabel,
  ...rest
}: InputProps) {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState(false);
  const sizeStyle = SIZE_STYLES[size];
  const eyeStyle = EYE_STYLES[size];

  const eyeButton = secret ? (
    <button
      type="button"
      onClick={() => setRevealed((v) => !v)}
      className={cn(
        'absolute top-1/2 -translate-y-1/2 text-[var(--settings-eye-icon)] transition-colors hover:text-[var(--settings-eye-icon-hover)]',
        // globals.css 的 F3 全局规则把 *:focus-visible 的 outline 抹掉了(只有 input /
        // textarea 恢复),按钮不自带焦点提示——键盘用户看不出焦点落在眼睛上。按 DESIGN.md
        // 的 Focus Blue 约定补 ring(--focus-ring),写法与其它图标按钮一致。
        'rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
        eyeStyle.offset,
      )}
      aria-label={revealed ? t('settings.apiKey.hideKey') : t('settings.apiKey.showKey')}
    >
      {revealed ? <Eye size={eyeStyle.iconSize} /> : <EyeOff size={eyeStyle.iconSize} />}
    </button>
  ) : null;
  const trailingNode = eyeButton ?? trailing;

  return (
    <div className={cn('relative', className)}>
      <input
        {...rest}
        ref={inputRef}
        aria-label={ariaLabel}
        type={secret ? (revealed ? 'text' : 'password') : type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={placeholder}
        disabled={disabled}
        // 只对密钥关掉:密码管理器建议和拼写红线对密钥是干扰,但普通文本字段(显示名称、
        // baseUrl、模型名、请求头)该保留浏览器的自动补全与拼写检查,不能一并禁掉。
        autoComplete={secret ? 'off' : autoComplete}
        spellCheck={secret ? false : spellCheck}
        className={cn(
          'w-full rounded-full outline-none transition-colors',
          sizeStyle.box,
          sizeStyle.paddingLeft,
          trailingNode ? sizeStyle.trailingPaddingRight : sizeStyle.paddingRight,
          mono && 'font-mono',
          FIELD_CHROME,
          SURFACE_STYLES[surface],
          error && ERROR_CHROME,
          disabled && 'cursor-not-allowed opacity-60',
        )}
        // 调用方内联样式后置于组件内置的文本选择样式之后：caller 可以覆盖
        // userSelect 等任何键，内置样式不再静默丢弃调用方的 style（Greptile P2）。
        style={{ userSelect: 'text', WebkitUserSelect: 'text', ...style }}
      />
      {trailingNode}
    </div>
  );
}

export interface TextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange'> {
  value: string;
  onChange: (v: string) => void;
  surface?: InputSurface;
  error?: boolean;
}

/** 多行输入：圆角一律 8px（§5），不走胶囊。 */
export function Textarea({
  value,
  onChange,
  onBlur,
  placeholder,
  surface = 'elevated',
  error = false,
  className,
  disabled,
  style,
  ...rest
}: TextareaProps) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      placeholder={placeholder}
      disabled={disabled}
      className={cn(
        'w-full rounded-lg px-3 py-2 text-13 outline-none transition-colors',
        FIELD_CHROME,
        SURFACE_STYLES[surface],
        error && ERROR_CHROME,
        disabled && 'cursor-not-allowed opacity-60',
        className,
      )}
      {...rest}
      // 与 Input 相同的合并次序：内置文本选择样式在前，调用方 style 在后。
      style={{ userSelect: 'text', WebkitUserSelect: 'text', ...style }}
    />
  );
}
