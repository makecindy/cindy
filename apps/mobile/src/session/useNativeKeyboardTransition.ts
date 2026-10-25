/** Android keeps its existing window/keyboard ownership. Do not register
 * Reanimated's Android keyboard observer: doing so changes adjustResize. */
export function useNativeKeyboardTransition(): { readonly value: boolean } | undefined {
  return undefined;
}
