import { createContext } from "react";
import type { ButtonProps } from "@expo/ui/swift-ui";

/**
 * 预览外壳的系统原生画法(iOS SwiftUI)。App 里能用原生控件的地方都用原生:按钮、
 * 玻璃、菜单与载入指示都交给系统,玻璃随背后内容变亮变暗、图标跟着换色、按下的
 * 液态反馈都由系统负责。其它平台用 React Native 画同样的结构。
 */
export type PreviewSystemImage = NonNullable<ButtonProps["systemImage"]>;

/** 处在一个原生按钮组(SwiftUI Host)里:组内的按钮与文字必须画成原生控件。 */
export const PreviewNativeGroupContext = createContext(false);

export interface NativePreviewButtonProps {
  label: string;
  systemImage: PreviewSystemImage;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
  hint?: string;
  /** 图标旁的文字(如视频下载进度);不传时只显示图标。 */
  title?: string;
}

export interface NativePreviewMenuAction {
  key: string;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}

export interface NativePreviewHeaderProps {
  name: string;
  onClose: () => void;
  closeLabel: string;
  closeDisabled: boolean;
  closeTestID: string;
  moreLabel: string;
  actions: readonly NativePreviewMenuAction[];
}
