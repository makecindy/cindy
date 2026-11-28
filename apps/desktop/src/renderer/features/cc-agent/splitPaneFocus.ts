import { createContext, useContext } from 'react';

// Outside a split, the route owns the window chrome as usual.
export const SplitPaneFocusContext = createContext<boolean | null>(null);
export const useSplitPaneFocus = () => useContext(SplitPaneFocusContext) ?? true;
// A focused companion pane owns the route, but still has its own pane header.
export const useInCompanionSplitPane = () => useContext(SplitPaneFocusContext) !== null;

// An explicit route action can activate its pane and navigate in one step.
export const SplitPaneRouteActivationContext = createContext<((route: string) => void) | null>(null);
export const useSplitPaneRouteActivation = () => useContext(SplitPaneRouteActivationContext);
