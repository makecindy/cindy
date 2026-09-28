import { HeaderHeightContext } from 'expo-router/react-navigation';
import { useContext } from 'react';

// The home surface also renders inside the session drawer, where no screen
// header context exists. Only the native-header layout consumes this height.
export function useOptionalHeaderHeight(): number {
  return useContext(HeaderHeightContext) ?? 0;
}
