/**
 * Shared Radix Switch. The approved HTML study supplies the subtle thumb motion;
 * Radix still owns checked/defaultChecked, keyboard activation and form events.
 * Colors remain theme tokens; the CINDY dark skin opts into the bright thumb.
 */
import * as React from 'react';
import * as SwitchPrimitives from '@radix-ui/react-switch';

import { cn } from '@/lib/utils';
import './switch.css';

// Rem geometry follows the existing h-4/w-4 thumb and UI scaling.
const THUMB_SIZE = 16;
const HOVER_WIDTH = 17;
const PRESS_WIDTH = 18;
const PRESS_HEIGHT = 14;
const DRAG_THRESHOLD = 2;

type Gesture = {
  id: number;
  button: HTMLButtonElement;
  startX: number;
  originX: number;
  scale: number;
  maxX: number;
  x: number;
  dragging: boolean;
};

const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(
  (
    {
      className,
      disabled,
      onClick,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onLostPointerCapture,
      onPointerEnter,
      onPointerLeave,
      onKeyDown,
      onKeyUp,
      onBlur,
      ...props
    },
    ref,
  ) => {
    const thumbRef = React.useRef<HTMLSpanElement>(null);
    const gesture = React.useRef<Gesture | null>(null);
    const suppressPointerClick = React.useRef<(() => void) | null>(null);
    const [hovered, setHovered] = React.useState(false);
    const [pressed, setPressed] = React.useState(false);
    const [dragX, setDragX] = React.useState<number | null>(null);

    const clearClickSuppression = () => {
      suppressPointerClick.current?.();
      suppressPointerClick.current = null;
    };
    const suppressGestureClick = (button: HTMLButtonElement) => {
      clearClickSuppression();
      const document = button.ownerDocument;
      // A cancelled gesture may produce no click. A new interaction, including
      // one on an associated label, must always be allowed to activate Radix.
      document.addEventListener('pointerdown', clearClickSuppression, {
        capture: true,
        once: true,
      });
      suppressPointerClick.current = () =>
        document.removeEventListener('pointerdown', clearClickSuppression, true);
    };
    const releaseCapture = () => {
      const active = gesture.current;
      gesture.current = null;
      if (active?.button.hasPointerCapture(active.id)) {
        active.button.releasePointerCapture(active.id);
      }
    };
    const cancel = () => {
      if (gesture.current) suppressGestureClick(gesture.current.button);
      releaseCapture();
      setPressed(false);
      setDragX(null);
    };
    React.useEffect(() => {
      if (disabled) {
        cancel();
        setHovered(false);
      }
    }, [disabled]);
    React.useEffect(
      () => () => {
        releaseCapture();
        clearClickSuppression();
      },
      [],
    );

    const thumbWidth =
      !disabled && pressed ? PRESS_WIDTH : !disabled && hovered ? HOVER_WIDTH : THUMB_SIZE;
    const thumbHeight = !disabled && pressed ? PRESS_HEIGHT : THUMB_SIZE;
    const thumbStyle = {
      '--switch-thumb-width': `${thumbWidth / THUMB_SIZE}rem`,
      '--switch-thumb-height': `${thumbHeight / THUMB_SIZE}rem`,
      ...(dragX !== null && !disabled ? { '--switch-drag-x': `${dragX}px` } : {}),
    } as React.CSSProperties;

    return (
      <SwitchPrimitives.Root
        {...props}
        ref={ref}
        disabled={disabled}
        className={cn(
          'cindy-switch peer relative inline-flex h-5 w-9 shrink-0 cursor-pointer touch-pan-y select-none items-center rounded-full border-2 border-transparent transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          'disabled:cursor-not-allowed disabled:opacity-[var(--switch-disabled-opacity)]',
          'data-[state=checked]:bg-[var(--switch-track-on)] data-[state=unchecked]:bg-[var(--switch-track-off)]',
          className,
        )}
        onClick={(event) => {
          // Drag release invokes the ordinary Radix click once. Suppress only the
          // subsequent native pointer click, never keyboard or label activation.
          if (suppressPointerClick.current && event.detail > 0) {
            clearClickSuppression();
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          onClick?.(event);
        }}
        onPointerEnter={(event) => {
          onPointerEnter?.(event);
          if (!event.defaultPrevented && !disabled && event.pointerType === 'mouse')
            setHovered(true);
        }}
        onPointerLeave={(event) => {
          onPointerLeave?.(event);
          setHovered(false);
        }}
        onPointerDown={(event) => {
          onPointerDown?.(event);
          if (
            event.defaultPrevented ||
            disabled ||
            event.button !== 0 ||
            !event.isPrimary ||
            gesture.current
          )
            return;
          const button = event.currentTarget;
          const thumb = thumbRef.current;
          if (!thumb) return;
          const bounds = button.getBoundingClientRect();
          const scale = bounds.width / button.offsetWidth || 1;
          const rem = parseFloat(getComputedStyle(button.ownerDocument.documentElement).fontSize);
          const maxX = Math.max(0, button.clientWidth - (PRESS_WIDTH / THUMB_SIZE) * rem);
          const originX = Math.max(
            0,
            Math.min(
              maxX,
              (thumb.getBoundingClientRect().left - bounds.left) / scale - button.clientLeft,
            ),
          );
          clearClickSuppression();
          gesture.current = {
            id: event.pointerId,
            button,
            startX: event.clientX,
            originX,
            scale,
            maxX,
            x: originX,
            dragging: false,
          };
          button.setPointerCapture(event.pointerId);
          setPressed(true);
        }}
        onPointerMove={(event) => {
          onPointerMove?.(event);
          const active = gesture.current;
          if (event.defaultPrevented || !active || active.id !== event.pointerId) return;
          const delta = (event.clientX - active.startX) / active.scale;
          if (!active.dragging && Math.abs(delta) < DRAG_THRESHOLD) return;
          active.dragging = true;
          active.x = Math.max(0, Math.min(active.maxX, active.originX + delta));
          setDragX(active.x);
        }}
        onPointerUp={(event) => {
          onPointerUp?.(event);
          const active = gesture.current;
          if (!active || active.id !== event.pointerId) return;
          releaseCapture();
          setPressed(false);
          setDragX(null);
          if (event.pointerType !== 'mouse') setHovered(false);
          if (active.dragging) {
            suppressGestureClick(active.button);
            const next = active.x > active.maxX / 2;
            if (
              !event.defaultPrevented &&
              !disabled &&
              next !== (event.currentTarget.dataset.state === 'checked')
            ) {
              event.currentTarget.click();
            }
          }
        }}
        onPointerCancel={(event) => {
          onPointerCancel?.(event);
          if (gesture.current?.id === event.pointerId) {
            cancel();
            setHovered(false);
          }
        }}
        onLostPointerCapture={(event) => {
          onLostPointerCapture?.(event);
          if (gesture.current?.id === event.pointerId) cancel();
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented || disabled) return;
          if (event.key === ' ' || event.key === 'Enter') setPressed(true);
          if (event.key === 'Escape') cancel();
        }}
        onKeyUp={(event) => {
          onKeyUp?.(event);
          if (event.key === ' ' || event.key === 'Enter') setPressed(false);
        }}
        onBlur={(event) => {
          onBlur?.(event);
          cancel();
        }}
      >
        <SwitchPrimitives.Thumb
          ref={thumbRef}
          style={thumbStyle}
          data-dragging={dragX !== null && !disabled ? '' : undefined}
          className={cn(
            'cindy-switch-thumb pointer-events-none block shrink-0 rounded-full ring-0',
            'data-[disabled]:opacity-[var(--switch-disabled-thumb-opacity)]',
            'data-[state=checked]:bg-[var(--switch-thumb-on)] data-[state=unchecked]:bg-[var(--switch-thumb-off)]',
          )}
        />
      </SwitchPrimitives.Root>
    );
  },
);
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
