import type { ReactNode } from "react";
import type {
  NativePreviewButtonProps,
  NativePreviewHeaderProps,
} from "./PreviewNativeChrome.types";

/** 非 iOS:预览外壳由 PreviewChrome 的 React Native 画法负责,这里的原生控件不会被渲染。 */
export const NATIVE_PREVIEW_CHROME = false;

export function NativePreviewButton(_: NativePreviewButtonProps): ReactNode {
  return null;
}

export function NativePreviewLabel(_: { text: string }): ReactNode {
  return null;
}

export function NativePreviewGroup(_: { children: ReactNode }): ReactNode {
  return null;
}

export function NativePreviewLoadingPill(_: { label: string; testID?: string }): ReactNode {
  return null;
}

export function NativePreviewHeader(_: NativePreviewHeaderProps): ReactNode {
  return null;
}
