import type { Image } from '@expo/ui/swift-ui';
import type { ComponentProps, ReactNode } from 'react';

export type AudioPlayerSymbolProps = {
  name: NonNullable<ComponentProps<typeof Image>['systemName']>;
  size: number;
  color: string;
  children: ReactNode;
};

export function AudioPlayerSymbol({ children }: AudioPlayerSymbolProps) {
  return <>{children}</>;
}
