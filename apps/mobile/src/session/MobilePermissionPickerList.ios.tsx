import { ComposerNativeSection as Section } from './ComposerNativeSection';

import { permissionOptionsForDisplay } from "./mobilePermissionPickerOptions";
import { permissionPresentation } from "./permissionPresentation";
import { ComposerNativeRow } from "./ComposerNativeRow";
import type { MobilePermissionPickerListProps } from "./MobilePermissionPickerList";
export function MobilePermissionPickerList(
  props: MobilePermissionPickerListProps,
) {
  return (
    <Section>
      {permissionOptionsForDisplay(props.options, props.activeMode).map(
        (option) => (
          <ComposerNativeRow
            key={option.id}
            title={permissionPresentation(option.id, option.label).label}
            selected={option.id === props.activeMode}
            disabled={props.disabled}
            onPress={() => props.onSelect(option.id)}
            testID={props.testID}
          />
        ),
      )}
    </Section>
  );
}
