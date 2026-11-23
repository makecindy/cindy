import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * Android 桌面入口组件（设置 → 添加小组件里的「Cindy 快捷入口」）。
 *
 * JS 只写「目标列表」：新建任务与每位伙伴的标题、电脑名、深链和图标。组件本身不联网、
 * 不读登录态；旧安装包没有这个原生模块时返回 null，相关代码整体跳过。
 */
type CindyEntryWidgetNative = {
  /** 返回写入后的目标数量；写入失败返回 -1。 */
  writeTargets(json: string): Promise<number>;
  targetCount(): Promise<number>;
};

export type EntryWidgetIcon =
  | { kind: 'image'; pngBase64: string; background?: string }
  | { kind: 'glyph'; text: string; background?: string };

export type EntryWidgetTarget = {
  id: string;
  title: string;
  subtitle: string;
  url: string;
  icon?: EntryWidgetIcon;
};

export const cindyEntryWidget = requireOptionalNativeModule<CindyEntryWidgetNative>('CindyEntryWidget');

export async function writeEntryWidgetTargets(targets: readonly EntryWidgetTarget[]): Promise<boolean> {
  if (!cindyEntryWidget) return false;
  try {
    return (await cindyEntryWidget.writeTargets(JSON.stringify({ version: 1, targets }))) >= 0;
  } catch {
    return false;
  }
}
