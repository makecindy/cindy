import type { ReactNode } from "react";

export interface ShareImageNativeButtonProps {
  label: string;
  disabled: boolean;
  onPress(): void;
  children: ReactNode;
}

/** Non-iOS platforms retain the existing share action. */
export function ShareImageNativeButton({
  children,
}: ShareImageNativeButtonProps) {
  return <>{children}</>;
}
