import { type ComponentType, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { MAX_FONT_SIZE_MULTIPLIER } from '@/components/AppText';
import { useWindowFontScale } from '@/platform/windowDimension';
import { MarkdownSelectableSpan } from './MarkdownSelectableText';

type IndentProps = { indent: number; firstLineIndent: number; children: ReactNode };
let AndroidParagraph: ComponentType<IndentProps> | null = null;
const androidNative = Platform.OS === 'android'
  ? requireOptionalNativeModule<{ registerListIndent?: () => boolean }>('CindySelectionMenu')
  : null;
let registered = false;

/** Keep paragraph layout inside one native text tree so selection crosses items. */
export function MarkdownListParagraph({ indent, continuation, children }: {
  indent: number;
  continuation: boolean;
  children: ReactNode;
}) {
  const fontScale = useWindowFontScale();
  const scaledIndent = indent * Math.min(fontScale, MAX_FONT_SIZE_MULTIPLIER);
  const firstLineIndent = continuation ? scaledIndent : 0;
  if (Platform.OS === 'ios') {
    // UIKit's shadow node applies exactly the same multiplier as its fonts.
    return <MarkdownSelectableSpan paragraphIndent={indent} paragraphFirstLineIndent={continuation ? indent : 0}>
      {children}
    </MarkdownSelectableSpan>;
  }
  if (!registered) registered = androidNative?.registerListIndent?.() === true;
  if (registered && !AndroidParagraph) {
    AndroidParagraph = (require('react-native/Libraries/Text/requireNativeTextEffect').default as
      (name: string) => ComponentType<IndentProps>)('cindy-list-indent');
  }
  // Old installed native packages keep their existing prefix rendering until
  // upgraded. They must not crash or lose selectable text on an OTA bundle.
  return AndroidParagraph && registered
    ? <AndroidParagraph indent={scaledIndent} firstLineIndent={firstLineIndent}>{children}</AndroidParagraph>
    : <>{children}</>;
}
