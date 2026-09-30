/** Shared numeric Slider. Media and effort variants live alongside this primitive. */
import * as React from 'react';
import * as SliderPrimitives from '@radix-ui/react-slider';

import { cn } from '@/lib/utils';
import './slider.css';

const Slider = React.forwardRef<
  React.ComponentRef<typeof SliderPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitives.Root>
>(
  (
    {
      className,
      'aria-label': label,
      'aria-labelledby': labelledBy,
      'aria-describedby': describedBy,
      'aria-valuetext': valueText,
      onPointerDown,
      onPointerUp,
      onPointerCancel,
      onLostPointerCapture,
      onValueChange,
      value,
      defaultValue = [0],
      ...props
    },
    ref,
  ) => {
    const [internalValue, setInternalValue] = React.useState(defaultValue);
    const values = value ?? internalValue;
    const [pressed, setPressed] = React.useState(false);
    const gesture = React.useRef<{ id: number; target: Element; before: number[] } | null>(null);
    const change = (next: number[]) => {
      setInternalValue(next);
      onValueChange?.(next);
    };
    const cancel = () => {
      const current = gesture.current;
      if (!current) return;
      gesture.current = null;
      setPressed(false);
      change(current.before);
      if (current.target.hasPointerCapture(current.id))
        current.target.releasePointerCapture(current.id);
    };
    React.useEffect(() => {
      if (props.disabled) cancel();
      const view = gesture.current?.target.ownerDocument.defaultView;
      view?.addEventListener('blur', cancel);
      return () => view?.removeEventListener('blur', cancel);
    });
    return (
      <SliderPrimitives.Root
        ref={ref}
        className={cn('cindy-slider', className)}
        {...props}
        value={values}
        onValueChange={change}
        data-pressed={pressed || undefined}
        onPointerDown={(event) => {
          onPointerDown?.(event);
          if (props.disabled || event.button !== 0 || event.isPrimary === false || gesture.current)
            event.preventDefault();
          if (event.defaultPrevented) return;
          gesture.current = {
            id: event.pointerId,
            target: event.target as Element,
            before: [...values],
          };
          setPressed(true);
        }}
        onPointerUp={(event) => {
          onPointerUp?.(event);
          if (gesture.current?.id !== event.pointerId) {
            event.preventDefault();
            return;
          }
          gesture.current = null;
          setPressed(false);
        }}
        onPointerCancel={(event) => {
          onPointerCancel?.(event);
          if (gesture.current?.id === event.pointerId) cancel();
        }}
        onLostPointerCapture={(event) => {
          onLostPointerCapture?.(event);
          if (gesture.current?.id === event.pointerId) cancel();
        }}
      >
        <SliderPrimitives.Track className="cindy-slider-track">
          <SliderPrimitives.Range className="cindy-slider-fill" />
        </SliderPrimitives.Track>
        <SliderPrimitives.Thumb
          aria-label={label}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          aria-valuetext={valueText}
          className="cindy-slider-thumb"
        />
      </SliderPrimitives.Root>
    );
  },
);
Slider.displayName = 'Slider';
export { Slider };
