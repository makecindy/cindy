/** Zero-native-dep gesture contexts shared by group message text, links, quotes, and thread headers. */
import { createContext, useCallback, useContext } from 'react';

export const BotGroupChildLongPressContext = createContext<(() => void) | null>(null);
export const BotGroupMessageLongPressTriggerContext = createContext<(() => void) | null>(null);
export const BotGroupSwipeSuppressionContext = createContext<Set<() => void> | null>(null);
export const BotGroupLinkLongPressContext = createContext<((url: string) => void) | null>(null);

export function useSuppressMessageLongPress(): () => void {
  const suppress = useContext(BotGroupChildLongPressContext);
  return useCallback(() => {
    suppress?.();
  }, [suppress]);
}

export function useTriggerMessageLongPress(): (() => void) | null {
  return useContext(BotGroupMessageLongPressTriggerContext);
}
