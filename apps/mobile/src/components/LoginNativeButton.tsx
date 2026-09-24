import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

export interface LoginNativeButtonProps {
  label: string;
  accessibilityLabel?: string;
  onPress?: () => void;
  disabled?: boolean;
  busy?: boolean;
  testID?: string;
  width?: number;
  height: number;
  fontSize: number;
  style?: StyleProp<ViewStyle>;
  variant?: 'primary' | 'secondary' | 'text' | 'circle';
  subtitle?: string;
  children?: ReactNode;
  trailingArtwork?: ReactNode;
  showLabel?: boolean;
  selected?: boolean;
  artworkSize?: number;
}

// Other platforms keep LoginSkinControls' existing React Native controls.
export const hasNativeLoginButtons = false;
export function LoginNativeButton(_props: LoginNativeButtonProps) { return null; }
