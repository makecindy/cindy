import { useEffect, useRef } from 'react';
import type { HudPointerRegion, HudState } from '../../../shared/hud';

/** Explicit UI boundaries, not pixel transparency, decide which software gets a click. */
export function getHudPointerRegion(target: Element | null): HudPointerRegion {
  if (!target) return 'controls';
  if (
    target.closest(
      '.hud-chrome,.hud-settings-overlay,[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper]',
    )
  )
    return 'controls';
  if (target.closest('[data-chat-input-root],[data-hud-composer],[data-hud-draft-composer]'))
    return 'composer';
  const message = target
    .closest('[data-hud-pointer-region]')
    ?.getAttribute('data-hud-pointer-region');
  if (message === 'userMessages' || message === 'assistantMessages') return message;
  // Work/tool groups use the assistant region too; virtualized empty space remains background.
  const item = target.closest('.wallpaper-message-viewport [data-render-item-key]');
  if (item && !item.querySelector('[data-hud-pointer-region="userMessages"]'))
    return 'assistantMessages';
  return target.closest('.hud-mode') ? 'background' : 'controls';
}
export function useHudPointerRouting(hud: HudState) {
  const point = useRef<{ x: number; y: number } | null>(null);
  const ownGesture = useRef(false);
  useEffect(() => {
    if (!hud.active) return;
    let frame = 0;
    let externalGesture = false;
    let last: HudPointerRegion | null = null;
    const report = () => {
      frame = 0;
      if (externalGesture) return;
      const p = point.current;
      const region =
        ownGesture.current || !p
          ? 'controls'
          : getHudPointerRegion(document.elementFromPoint(p.x, p.y));
      if (region === last) return;
      last = region;
      void window.electronAPI.hud.setPointerRegion(region).catch(() => {
        // Fail to an interactive window if the bridge becomes unavailable.
        void window.electronAPI.hud.setPassThrough(false).catch(() => {});
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(report);
    };
    const move = (event: MouseEvent) => {
      point.current = { x: event.clientX, y: event.clientY };
      // Never steal an in-progress drag from an application underneath the HUD.
      externalGesture = Boolean(event.buttons && !ownGesture.current);
      if (externalGesture) return;
      schedule();
    };
    const down = () => {
      ownGesture.current = true;
      externalGesture = false;
      schedule();
    };
    const up = () => {
      ownGesture.current = false;
      externalGesture = false;
      schedule();
    };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mousedown', down, true);
    window.addEventListener('mouseup', up, true);
    window.addEventListener('blur', up);
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    const observer = new MutationObserver(schedule);
    if (hud.passThrough)
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mousedown', down, true);
      window.removeEventListener('mouseup', up, true);
      window.removeEventListener('blur', up);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
    };
  }, [hud.active, hud.passThrough, hud.settings, hud.moving]);
}
