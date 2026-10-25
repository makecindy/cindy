import type {ResponseObserver} from '@cindy/anthropic-compat-proxy';
export function composeResponseObservers(
  ...observers: ResponseObserver[]
): ResponseObserver {
  return (ctx) => {
    const sinks = observers
      .map((observer) => {
        try {
          return observer(ctx) ?? null;
        } catch {
          return null;
        }
      })
      .filter((sink): sink is NonNullable<typeof sink> => Boolean(sink));
    if (sinks.length === 0) return undefined;
    if (sinks.length === 1) return sinks[0];
    return {
      onData: (chunk) => {
        for (const sink of sinks) sink.onData?.(chunk);
      },
      onEnd: () => {
        for (const sink of sinks) sink.onEnd?.();
      },
      onError: (err) => {
        for (const sink of sinks) sink.onError?.(err);
      },
    };
  };
}
