import { createContext, useContext, useState, type Dispatch, type SetStateAction } from 'react';
import { useRecyclingState } from '@legendapp/list/react-native';

export type RowStateHook = <T>(initial: T | (() => T)) => readonly [T, Dispatch<SetStateAction<T>>];

/**
 * True only inside a LegendList message row. LegendList's recycling state reads the
 * list store and throws outside it, while group chats, threads and cloud companions
 * render the same message bodies in an ordinary ScrollView.
 */
export const LegendListRowContext = createContext(false);

/** Pick the state hook once per mount: recycled rows reset per item, other hosts use React state. */
export function useRowStateHook(): RowStateHook {
  return useContext(LegendListRowContext) ? useRecyclingState : useState;
}
