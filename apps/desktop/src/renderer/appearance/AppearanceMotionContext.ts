import { createContext, useContext } from 'react';

/** Read-only projection of the ThemeProvider's existing Host subscription. */
export const AppearanceMotionContext = createContext(false);
export const useAppearanceReducedMotion = () => useContext(AppearanceMotionContext);
