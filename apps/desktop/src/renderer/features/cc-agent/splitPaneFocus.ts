import { createContext, useContext } from 'react';

// Outside a split, the route owns the window chrome as usual.
export const SplitPaneFocusContext = createContext(true);
export const useSplitPaneFocus = () => useContext(SplitPaneFocusContext);

// An explicit route action can activate its pane and navigate in one step.
export const SplitPaneRouteActivationContext = createContext<((route: string) => void) | null>(null);
export const useSplitPaneRouteActivation = () => useContext(SplitPaneRouteActivationContext);
