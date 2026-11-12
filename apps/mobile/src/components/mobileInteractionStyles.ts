import type { ViewStyle } from 'react-native';

/**
 * Shared press feedback for primitives and custom compact action frames.
 * Plain style object (not StyleSheet.create) so importing it has no module-load
 * dependency on react-native — partial react-native test mocks stay valid.
 */
export const mobileInteractionStyles = {
  pressed: { opacity: 0.72 },
} as const satisfies Record<string, ViewStyle>;
