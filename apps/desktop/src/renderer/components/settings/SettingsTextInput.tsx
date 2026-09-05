/**
 * SettingsTextInput —— `components/ui/input` 的设置页薄封装。
 *
 * DS-4 把实现升格进 `components/ui/input.tsx`。本文件保留原导出名与类型别名，
 * 让既有设置页调用点零行为改动（除 ivory 登记债与 placeholder 已收口到
 * `--text-placeholder`）。新代码请直接 import `{ Input }` from `@/components/ui/input`。
 */
export { Input as SettingsTextInput } from '@/components/ui/input';
export type {
  InputSize as SettingsTextInputSize,
  InputSurface as SettingsTextInputSurface,
} from '@/components/ui/input';
