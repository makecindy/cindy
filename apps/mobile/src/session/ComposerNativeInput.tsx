import { forwardRef } from "react";
import type {
  ComposerRichInputHandle,
  ComposerRichInputProps,
} from "./ComposerRichInput";
export const nativeComposerAvailable = false;
export const ComposerNativeInput = forwardRef<
  ComposerRichInputHandle,
  ComposerRichInputProps
>(function ComposerNativeInput() {
  return null;
});
