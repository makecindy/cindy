import type { ReactNode } from "react";
import { AnchoredPullDownMenu } from "@/platform/chrome/AnchoredPullDownMenu";
import {
  NativePullDownMenu,
  usesNativePullDownMenu,
  type NativePullDownAction,
} from "@/platform/chrome/NativePullDownMenu";
import { HomeHeaderGlassButton } from "./HomeHeaderGlassButton";

export interface HomeDisplayMenuProps {
  actions: readonly NativePullDownAction[];
  children: ReactNode;
  accessibilityLabel: string;
  onAction(id: string): void;
}

/** Non-iOS keeps the existing anchored menu and the shared action model. */
export function HomeDisplayMenu(props: HomeDisplayMenuProps) {
  const children = (
    <HomeHeaderGlassButton
      accessibilityLabel={props.accessibilityLabel}
      onPress={() => undefined}
      testID="home.displaySettingsButton"
    >
      {props.children}
    </HomeHeaderGlassButton>
  );
  return usesNativePullDownMenu() ? (
    <NativePullDownMenu {...props}>{children}</NativePullDownMenu>
  ) : (
    <AnchoredPullDownMenu {...props}>{children}</AnchoredPullDownMenu>
  );
}
