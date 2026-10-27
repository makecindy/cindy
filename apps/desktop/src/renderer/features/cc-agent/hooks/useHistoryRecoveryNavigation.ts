import { useCallback, useEffect, useRef, useState } from 'react';

/** A new source turn or input intent permanently supersedes an in-flight recovery's navigation. */
export function useHistoryRecoveryNavigation(input: {
  source: string;
  running: boolean;
  startedAt: number | null;
  endedAt: number | null;
}) {
  const [operations, setOperations] = useState<ReadonlyMap<string, symbol>>(() => new Map());
  const operationsRef = useRef(operations);
  const current = useRef({ ...input });
  const previous = current.current;
  if (previous.source !== input.source || previous.running !== input.running ||
    previous.startedAt !== input.startedAt || previous.endedAt !== input.endedAt) {
    current.current = { ...input };
  }
  const invalidate = useCallback(() => {
    current.current = { ...current.current };
  }, []);
  useEffect(() => invalidate, [invalidate]);

  const isPending = useCallback(() => operationsRef.current.has(current.current.source), []);
  const begin = useCallback(() => {
    const source = current.current;
    if (source.running || operationsRef.current.has(source.source)) return null;
    // HashRouter can update browser history before React renders the new source.
    const href = window.location.href;
    const locationKey = window.history.state?.key;
    const token = Symbol();
    const next = new Map(operationsRef.current);
    next.set(source.source, token);
    operationsRef.current = next;
    setOperations(next);
    return {
      isCurrent: () => current.current === source && window.location.href === href &&
        window.history.state?.key === locationKey,
      release: () => {
        if (operationsRef.current.get(source.source) !== token) return;
        const remaining = new Map(operationsRef.current);
        remaining.delete(source.source);
        operationsRef.current = remaining;
        setOperations(remaining);
      },
    };
  }, []);
  return { begin, invalidate, isPending, pending: operations.has(input.source) };
}
