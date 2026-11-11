import type { ComponentProps } from "react";
import { NativeChromeButton } from "@/platform/chrome/NativeChromeButton.ios";
import type { HomeHeaderGlassButton as FallbackButton } from "./HomeHeaderGlassButton";

/** Preserve the existing artwork inside the same native glass button as Back. */
export function HomeHeaderGlassButton({
  accessibilityLabel,
  ...props
}: ComponentProps<typeof FallbackButton>) {
  return <NativeChromeButton {...props} label={accessibilityLabel} />;
}
