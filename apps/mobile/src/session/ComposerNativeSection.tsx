import type { ReactNode } from 'react';
export interface ComposerNativeSectionProps { title?: string; children: ReactNode; }
export function ComposerNativeSection({ children }: ComposerNativeSectionProps) { return <>{children}</>; }
