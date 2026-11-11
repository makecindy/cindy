import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import './videoContextMenu.css';

type MenuPosition = { x: number; y: number };

/** Keep the entire Radix positioning tree above native fullscreen video.
 * A body portal cannot escape the fullscreen top layer, regardless of z-index.
 */
export function useVideoContextMenu(videoRef: RefObject<HTMLVideoElement | null>, src: string) {
  const [menuPos, setPosition] = useState<MenuPosition | null>(null);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);
  const hostRef = useRef<HTMLElement | null>(null);

  const setMenuPos = useCallback(
    (position: MenuPosition | null) => {
      const video = videoRef.current;
      if (position && video && document.fullscreenElement === video) {
        if (!hostRef.current) {
          const host = document.createElement('dialog');
          host.className = 'video-context-menu-layer';
          // The Radix menu supplies semantics; this transparent dialog only lifts
          // its complete positioning tree and makes it interactive above video.
          host.setAttribute('role', 'presentation');
          Object.assign(host.style, {
            position: 'fixed',
            inset: '0',
            width: '100%',
            height: '100%',
            margin: '0',
            padding: '0',
            border: '0',
            background: 'transparent',
            overflow: 'visible',
            pointerEvents: 'auto',
            maxWidth: 'none',
            maxHeight: 'none',
          });
          video.parentElement!.appendChild(host);
          host.addEventListener('cancel', (event) => {
            event.preventDefault();
            setMenuPos(null);
          });
          host.showModal();
          hostRef.current = host;
        }
        setPortalContainer(hostRef.current);
      } else {
        hostRef.current?.remove();
        hostRef.current = null;
        setPortalContainer(null);
      }
      setPosition(position);
    },
    [videoRef],
  );

  useEffect(() => {
    setMenuPos(null);
    const close = () => setMenuPos(null);
    document.addEventListener('fullscreenchange', close);
    return () => {
      document.removeEventListener('fullscreenchange', close);
      hostRef.current?.remove();
      hostRef.current = null;
    };
  }, [src, setMenuPos]);

  const restoreVideoFocus = useCallback(
    (event: Event) => {
      // The zero-size trigger is outside fullscreen; return focus to the player.
      event.preventDefault();
      videoRef.current?.focus();
    },
    [videoRef],
  );

  return { menuPos, setMenuPos, portalContainer, restoreVideoFocus };
}
