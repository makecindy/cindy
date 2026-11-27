import { Host, Image } from '@expo/ui/swift-ui';
import { accessibilityHidden } from '@expo/ui/swift-ui/modifiers';
import type { AudioPlayerSymbolProps } from './AudioPlayerSymbol';

export function AudioPlayerSymbol({ name, size, color }: AudioPlayerSymbolProps) {
  return (
    <Host ignoreSafeArea="all" matchContents pointerEvents="none">
      <Image systemName={name} size={size} color={color} modifiers={[accessibilityHidden()]} />
    </Host>
  );
}
