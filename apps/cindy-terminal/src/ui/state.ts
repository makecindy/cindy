import { useRef, useState, type SetStateAction } from 'react';

/** Terminal events may share one stream read, ahead of the next React render. */
export function useInputState<T>(initial: T) {
  const [value, setValue] = useState(initial);
  const current = useRef(value);
  current.current = value;
  const update = (next: SetStateAction<T>) => {
    current.current = typeof next === 'function' ? (next as (before: T) => T)(current.current) : next;
    setValue(current.current);
  };
  return [value, update, current] as const;
}
