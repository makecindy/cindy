/**
 * SettingsTextInput —— `components/ui/input` 的设置页薄封装。
 *
 * 复用标准 Input 的尺寸、状态和行为，同时保留旧 settings-input-* 的局部主题合同。
 * alias 无覆盖时继续跟随 Tier-1；显式覆盖只影响既有设置输入，不提升成全局配色。
 * placeholder 沿用既有加载期归一化：缺新 slot 的旧主题先归一化，再解析 alias。
 * 新建通用界面直接使用 ui/input；迁移已有 settings 域输入时保留此封装。
 */
import { Input, type InputProps } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const LEGACY_INPUT_CHROME =
  'text-[var(--settings-input-text)] placeholder:text-[var(--settings-input-placeholder)] border-[var(--settings-input-border)] focus:border-[var(--settings-input-border-focus)]';

export function SettingsTextInput({ inputClassName, ...props }: InputProps) {
  return <Input {...props} inputClassName={cn(LEGACY_INPUT_CHROME, inputClassName)} />;
}

export type {
  InputSize as SettingsTextInputSize,
  InputSurface as SettingsTextInputSurface,
} from '@/components/ui/input';
