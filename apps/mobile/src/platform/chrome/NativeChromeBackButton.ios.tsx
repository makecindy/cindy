import type { ComponentProps } from "react";
import { NativeChromeButton } from "./NativeChromeButton.ios";

export function NativeChromeBackButton(
  props: Omit<ComponentProps<typeof NativeChromeButton>, "children" | "systemImage">,
) {
  return <NativeChromeButton {...props} systemImage="chevron.backward" />;
}
