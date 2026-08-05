/**
 * SettingsTextInput —— 设置页统一的单行文本 / 密钥输入框。
 *
 * 收敛背景：设置页各处原本各写一份私有 TextInput（高度 32 / 36 / 40 / 42px 混杂），
 * 密钥字段的「明文切换」只在 CustomProviderDialog 做了——同一个 API key 在「添加供应商」
 * 向导里看不见、在编辑弹窗里看得见。本组件以 CustomProviderDialog 那份为基线（它是唯一
 * 走 DESIGN.md §4-5 药丸圆角的实现），把 eye 显形收进 `secret`，调用点不再各自手写
 * showKey state + 按钮。
 *
 * `secret` 只显形**用户本次输入的草稿**（草稿本就在 renderer state 里）。已存密钥要不要
 * 回显由调用方决定：内置 API-key 走 MAIN_ONLY 的 builtinApiKey* IPC，renderer 架构上读不到
 * 明文，回显无从谈起；自定义供应商的 key 由调用方显式读回。本组件不触碰凭证读取边界。
 *
 * 尺寸：DESIGN.md §4 锁定单行输入的 radius（9999px）与颜色 token，未锁高度，因此保留
 * sm / md / lg 三档以贴合各调用点既有版式。radius 与 `--settings-input-*` token 不可变。
 */
import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

export type SettingsTextInputSize = 'sm' | 'md' | 'lg';
export type SettingsTextInputSurface = 'elevated' | 'ivory';

/**
 * 底色：默认 `elevated` = DESIGN.md §4 `input/text` 规定的 fill(`--surface-elevated`)。
 *
 * `ivory` 是给「输入压在白色弹窗面板上」的调用点保留的既有底色(`--settings-input-bg`,
 * 解析到 `--surface-card-ivory`)。这份 ivory 在设计文档里没有任何背书,属 colors.ts 的
 * 无文档漂移;它在白面板上能给出 fill 抬升,所以不在本 PR 里翻成白色,但也不能当默认——
 * settings 卡片本身就是 ivory(`--settings-theme-card-bg`),ivory 输入压在 ivory 卡上会和
 * 背景同色,填充对比度归零。settings 域这处 ivory / elevated 的收口是独立议题。
 */
const SURFACE_STYLES: Record<SettingsTextInputSurface, string> = {
  elevated: 'bg-[var(--surface-elevated)]',
  ivory: 'bg-[var(--settings-input-bg)]',
};

/** 各档的框体几何 + 无 trailing 时的右内边距（有 trailing 时统一让位给按钮）。 */
const SIZE_STYLES: Record<
  SettingsTextInputSize,
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
const EYE_STYLES: Record<SettingsTextInputSize, { iconSize: number; offset: string }> = {
  sm: { iconSize: 14, offset: 'right-[10px]' },
  md: { iconSize: 16, offset: 'right-[12px]' },
  lg: { iconSize: 16, offset: 'right-[12px]' },
};

export function SettingsTextInput({
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
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  /** `secret` 为真时由组件接管（明文 / 遮罩切换），此处传值无效。 */
  type?: string;
  size?: SettingsTextInputSize;
  /** 底色档:默认 §4 规定的 `--surface-elevated`;`ivory` 见 SURFACE_STYLES 注释。 */
  surface?: SettingsTextInputSurface;
  /** 等宽字体——密钥、ID 这类需要逐字核对的值。 */
  mono?: boolean;
  /** 密钥字段：遮罩输入 + 自带明文切换按钮。 */
  secret?: boolean;
  /** 自定义尾随元素（需自行绝对定位）。`secret` 优先，两者不叠加。 */
  trailing?: React.ReactNode;
  /** 附加到**外层容器**（内层 input 恒为 w-full），供 flex 行传 `flex-1 min-w-0`。 */
  className?: string;
}) {
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
        type={secret ? (revealed ? 'text' : 'password') : type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={placeholder}
        // 只对密钥关掉:密码管理器建议和拼写红线对密钥是干扰,但普通文本字段(显示名称、
        // baseUrl、模型名、请求头)该保留浏览器的自动补全与拼写检查,不能一并禁掉。
        autoComplete={secret ? 'off' : undefined}
        spellCheck={secret ? false : undefined}
        className={cn(
          // 单行输入按设计规范走药丸圆角(DESIGN.md §4-5:9999px,明令禁止 10px)。
          'w-full rounded-full outline-none transition-colors',
          sizeStyle.box,
          sizeStyle.paddingLeft,
          trailingNode ? sizeStyle.trailingPaddingRight : sizeStyle.paddingRight,
          mono && 'font-mono',
          'text-[var(--settings-input-text)] placeholder:text-[var(--settings-input-placeholder)]',
          SURFACE_STYLES[surface],
          'border border-[var(--settings-input-border)] focus:border-[var(--settings-input-border-focus)]',
          // Focus Blue 环(DESIGN.md §4 Inputs 的 focus 槽 + §「Focus Blue」的 --focus-ring):
          // 迁移进来的密钥输入原本就带 focus:ring-2,不能在收敛时丢掉——同一个表单里紧邻的
          // 名称框仍是蓝环,只留 border 变色会让上下两个框焦点表现不一致。用 opaque
          // --focus-ring 而非 --focus-ring-soft:与这些框的原值、以及相邻未迁移输入一致。
          'focus:ring-2 focus:ring-[var(--focus-ring)]',
        )}
        style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
      />
      {trailingNode}
    </div>
  );
}
