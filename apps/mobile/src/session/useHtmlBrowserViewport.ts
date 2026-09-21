import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Keyboard, Platform, View, useWindowDimensions, type KeyboardEvent } from 'react-native';
import { browserViewport, browserViewportScript, type BrowserFrame, type BrowserInsets } from './htmlBrowserViewport';

/** iOS 26 keeps full-bleed rendering; older platforms reserve actual layout space. */
export function useHtmlBrowserViewport(controls: BrowserInsets) {
  const viewRef = useRef<View>(null);
  const windowSize = useWindowDimensions();
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [keyboard, setKeyboard] = useState<BrowserFrame | null>(() => {
    const value = Keyboard.metrics();
    return value && value.screenY !== 0 ? { x: value.screenX, y: value.screenY, width: value.width, height: value.height } : null;
  });
  const measure = useCallback(() => {
    viewRef.current?.measureInWindow((x, y, width, height) => {
      if (width > 0 && height > 0) setFrame(old => old?.x === x && old.y === y && old.width === width && old.height === height ? old : { x, y, width, height });
    });
  }, []);
  useEffect(measure, [measure, windowSize.width, windowSize.height]);
  useEffect(() => {
    let generation = 0;
    const update = (event: KeyboardEvent) => {
      const current = ++generation;
      const end = event.endCoordinates;
      const rect = { x: end.screenX, y: end.screenY, width: end.width, height: end.height };
      if (Platform.OS === 'ios' && end.screenY === 0) {
        // Same OS cross-fade special case as RN KeyboardAvoidingView.
        void AccessibilityInfo.prefersCrossFadeTransitions().then(crossFade => {
          if (current === generation) setKeyboard(crossFade ? null : rect);
        }).catch(() => {
          if (current === generation) setKeyboard(rect);
        });
      } else setKeyboard(rect);
      measure();
    };
    const hide = () => { generation++; setKeyboard(null); measure(); };
    const subscriptions = [Keyboard.addListener('keyboardDidShow', update), Keyboard.addListener('keyboardDidHide', hide)];
    if (Platform.OS === 'ios') subscriptions.push(
      Keyboard.addListener('keyboardWillShow', update), Keyboard.addListener('keyboardWillHide', hide),
      Keyboard.addListener('keyboardWillChangeFrame', update), Keyboard.addListener('keyboardDidChangeFrame', update),
    );
    return () => { generation++; subscriptions.forEach(subscription => subscription.remove()); };
  }, [measure]);
  const outer = frame ? browserViewport(frame, controls, keyboard) : null;
  const edges = outer?.insets ?? controls;
  const nativeObscured = Platform.OS === 'ios' && Number.parseInt(String(Platform.Version), 10) >= 26;
  const viewportStyle = nativeObscured ? undefined : {
    paddingTop: edges.top,
    paddingBottom: frame ? Math.min(edges.bottom, Math.max(0, frame.height - edges.top)) : edges.bottom,
    paddingLeft: edges.left,
    paddingRight: frame ? Math.min(edges.right, Math.max(0, frame.width - edges.left)) : edges.right,
  };
  // Only the fallback excludes strips from the actual frame; do not deduct them twice.
  const clear = { top: 0, bottom: 0, left: 0, right: 0 };
  const script = outer ? browserViewportScript(nativeObscured ? outer : browserViewport({
    x: 0, y: 0, width: outer.availableWidth, height: outer.availableHeight,
  }, clear, null)) : undefined;
  return { viewRef, measure, viewportStyle, script,
    // WebKit combines keyboard occlusion itself; only browser chrome belongs in this prop.
    obscuredContentInsets: nativeObscured ? controls : undefined,
  };
}
