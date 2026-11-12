import { createContext, useContext } from 'react';

/** Read-only package motion; builtin themes do not subscribe to Host settings. */
export const AppearanceMotionContext = createContext(false);
export const useAppearanceReducedMotion = () => useContext(AppearanceMotionContext);
