import { ComposerNativeSection as Section } from './ComposerNativeSection';

import { permissionOptionsForDisplay } from "./mobilePermissionPickerOptions";
import { permissionAccentColor, permissionPresentation } from "./permissionPresentation";
import { RNHostView } from '@expo/ui/swift-ui';
import { View } from 'react-native';
import { iconSize, iconStroke, useTheme } from '@/theme';
import { ComposerNativeRow } from "./ComposerNativeRow";
import type { MobilePermissionPickerListProps } from "./MobilePermissionPickerList";
export function MobilePermissionPickerList(
  props: MobilePermissionPickerListProps,
) {
  const { colors } = useTheme();
  return (
    <Section>
      {permissionOptionsForDisplay(props.options, props.activeMode).map(
        (option) => {
          const presentation = permissionPresentation(option.id, option.label);
          const selected = option.id === props.activeMode;
          return (
          <ComposerNativeRow
            key={option.id}
            title={presentation.label}
            leading={<RNHostView matchContents>
              <View accessible={false} pointerEvents="none" style={{ width: iconSize.action, height: iconSize.action }}>
                <presentation.Icon
                  size={iconSize.action}
                  strokeWidth={iconStroke.regular}
                  color={selected ? permissionAccentColor(presentation.accent, colors) : colors.textSecondary}
                />
              </View>
            </RNHostView>}
            selected={selected}
            disabled={props.disabled}
            onPress={() => props.onSelect(option.id)}
            testID={props.testID}
          />
        ); },
      )}
    </Section>
  );
}
