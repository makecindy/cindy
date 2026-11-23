import { useEffect, useState } from 'react';

import { isWindowHidden } from '@/lib/hiddenAnimationGate';

export function isWindowVisiblyFocused(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

export function isDocumentVisible(): boolean {
  return document.visibilityState === 'visible';
}

export function useWindowVisible(enabled = true): boolean {
  const [visible, setVisible] = useState(() => {
    if (!enabled) return false;
    if (typeof document === 'undefined') return true;
    return isWindowVisiblyFocused();
  });

  useEffect(() => {
    if (!enabled) {
      setVisible(false);
      return undefined;
    }
    const update = () => {
      setVisible(isWindowVisiblyFocused());
    };
    update();
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
    };
  }, [enabled]);

  return visible;
}

export function useDocumentVisible(enabled = true): boolean {
  const [visible, setVisible] = useState(() => {
    if (!enabled) return false;
    if (typeof document === 'undefined') return true;
    return isDocumentVisible();
  });

  useEffect(() => {
    if (!enabled) {
      setVisible(false);
      return undefined;
    }
    const update = () => {
      setVisible(isDocumentVisible());
    };
    update();
    document.addEventListener('visibilitychange', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
    };
  }, [enabled]);

  return visible;
}

/** Shown to the user: the document is visible and Main has not reported the window hidden. */
export function isWindowShown(): boolean {
  return isDocumentVisible() && !isWindowHidden();
}

/**
 * Like useDocumentVisible, but also honours Main's `window-hidden-change` broadcast. While a turn
 * or a voice call keeps background throttling off, a hidden or minimized window still reports
 * `visibilityState === 'visible'` (see hiddenAnimationGate), so the document signal alone is not
 * enough for work that must only happen while the user can see the window.
 */
export function useWindowShown(): boolean {
  const [shown, setShown] = useState(() => typeof document === 'undefined' || isWindowShown());

  useEffect(() => {
    let windowHidden = isWindowHidden();
    const update = () => setShown(isDocumentVisible() && !windowHidden);
    const offHidden = window.electronAPI?.onWindowHiddenChange?.((hidden) => {
      windowHidden = hidden;
      update();
    });
    update();
    document.addEventListener('visibilitychange', update);
    return () => {
      offHidden?.();
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  return shown;
}
