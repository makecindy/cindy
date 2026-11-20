import { createContext, useContext } from 'react';

// Outside a split, the route owns the window chrome as usual.
export const SplitPaneFocusContext = createContext(true);
export const useSplitPaneFocus = () => useContext(SplitPaneFocusContext);
