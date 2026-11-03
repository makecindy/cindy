import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { findNodeHandle, Platform, type Text as NativeText, type TextProps } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

import { Text } from '@/components/AppText';
import { i18n } from '@/i18n';
import { commitSelectionMenuAction, SelectionQuoteContext, selectionQuoteMenuLabel } from './selectionQuote';

interface SelectionMenuNative {
  attach(tag: number, registration: string, quoteLabel: string, sideChatLabel: string): Promise<void>;
  detach(registration: string): Promise<void>;
  addListener(name: 'onAction', handler: (event: { registration: string; action: string; text: string }) => void): { remove(): void };
}

const native = Platform.OS === 'android'
  ? requireOptionalNativeModule<SelectionMenuNative>('CindySelectionMenu')
  : null;
let nextRegistration = 0;

/** Keeps RN Text as the native carrier; old installations retain their system copy menu. */
export function SelectionMenuText({ onLayout, ...props }: TextProps) {
  const ctx = useContext(SelectionQuoteContext);
  const latestContext = useRef(ctx);
  useLayoutEffect(() => { latestContext.current = ctx; }, [ctx]);
  // The quote callback identifies the host/draft scope. A changing side-chat
  // callback in the same task must not detach a menu that is already on screen.
  const quoteCallback = ctx?.commitQuote;
  const textRef = useRef<NativeText>(null);
  const [tag, setTag] = useState<number | null>(null);
  const quoteLabel = selectionQuoteMenuLabel();
  const sideChatLabel = ctx?.askInSideChat ? i18n.t('session.sideChat.title') : '';
  useEffect(() => {
    if (!native || !tag || !props.selectable || !quoteCallback) return;
    const registration = String(++nextRegistration);
    const subscription = native.addListener('onAction', (event) => {
      const current = latestContext.current;
      if (event.registration === registration && current?.commitQuote === quoteCallback) {
        commitSelectionMenuAction(event.action, event.text, current);
      }
    });
    // Layout has committed, so Fabric can resolve the native TextView by its tag.
    // A view disappearing during navigation must not produce an unhandled rejection.
    void native.attach(tag, registration, quoteLabel, sideChatLabel).catch(() => {});
    return () => {
      subscription.remove();
      void native.detach(registration).catch(() => {});
    };
  }, [tag, props.selectable, quoteCallback, quoteLabel, sideChatLabel]);

  return <Text {...props} ref={textRef} onLayout={(event) => {
    if (native && ctx && props.selectable) setTag(findNodeHandle(textRef.current));
    onLayout?.(event);
  }} />;
}
