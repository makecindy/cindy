import { Image, Text } from '@expo/ui/swift-ui';
import { font, foregroundStyle, frame, listRowInsets } from '@expo/ui/swift-ui/modifiers';
import { iconSize, useTheme } from '@/theme';
import { spacing } from '@/theme/tokens';
import { ComposerSheet } from './ComposerSheet';
import { ComposerNativeSection } from './ComposerNativeSection';
import { ComposerNativeRow } from './ComposerNativeRow';
import { ComposerSectionSettingsHeader } from './composerSectionHeader';
import type { HomeSectionOptionsSheetProps } from './HomeSectionOptionsSheet';

const ROW_INSETS = [listRowInsets({ top: 0, bottom: 0, leading: spacing.lg, trailing: spacing.lg })];
const LEADING_ICON_WIDTH = 24;

/** Native iOS bottom sheet shared by Home section & category headers. */
export function HomeSectionOptionsSheet({
  visible,
  title,
  sections,
  testID,
  onClose,
  onClosed,
}: HomeSectionOptionsSheetProps) {
  const { colors } = useTheme();
  const visibleSections = sections.filter((section) => section.items.length > 0);

  return (
    <ComposerSheet
      nativeContent
      visible={visible}
      onClose={onClose}
      onClosed={onClosed}
      title={title}
      testID={testID}
    >
      <ComposerSectionSettingsHeader.Provider value={true}>
        {visibleSections.map((section) => (
          <ComposerNativeSection
            key={section.id}
            title={section.title}
            footer={section.footer ? (
              <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(colors.textSecondary)]}>
                {section.footer}
              </Text>
            ) : undefined}
          >
            {section.items.map((item) => (
              <ComposerNativeRow
                key={item.id}
                modifiers={ROW_INSETS}
                leading={item.sfSymbol ? (
                  <Image
                    systemName={item.sfSymbol as never}
                    size={iconSize.action}
                    modifiers={[foregroundStyle(colors.textSecondary), frame({ width: LEADING_ICON_WIDTH })]}
                  />
                ) : undefined}
                title={item.title}
                subtitle={item.subtitle}
                selected={item.selected}
                disabled={item.disabled}
                onPress={item.onPress}
                testID={item.testID}
              />
            ))}
          </ComposerNativeSection>
        ))}
      </ComposerSectionSettingsHeader.Provider>
    </ComposerSheet>
  );
}
