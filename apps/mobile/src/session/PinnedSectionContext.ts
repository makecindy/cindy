import { createContext, useContext } from 'react';

/** Presentation scope only: pinned search results keep their ordinary row styling. */
export const PinnedSectionContext = createContext(false);
export const usePinnedSection = () => useContext(PinnedSectionContext);
