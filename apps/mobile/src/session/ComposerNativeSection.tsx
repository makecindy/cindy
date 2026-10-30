import type { ReactNode } from 'react';
export interface ComposerNativeSectionProps {
  title?: string;
  footer?: ReactNode;
  children: ReactNode;
}
export function ComposerNativeSection({ children }: ComposerNativeSectionProps) { return <>{children}</>; }
