import { createContext, type ContextType } from 'react';
import { NavigationContext } from 'expo-router/react-navigation';

/** Deferred navigation belongs to the route, even after its temporary surface closes. */
export const NavigationActionContext = createContext<ContextType<typeof NavigationContext>>(undefined);
