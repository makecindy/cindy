/** Cindy built-in modules. Include this file in the author project's TS inputs; no npm package. */
declare module '@cindy/ext-apps' {
  export interface ConnectedApp {
    getHostCapabilities(): object | undefined;
    getHostContext(): object | undefined;
    /** The SDK owns request schemas; authors pass their existing connected App. */
    request: (...args: never[]) => Promise<unknown>;
    readonly transport?: unknown;
  }
  export interface ViewStateOptions { debounceMs?: number }
  export type StateUpdate<T> = T | ((previous: T) => T);
  export interface ViewState<T> {
    get(): T;
    /** Subscribe to this App's local edits; returns an unsubscribe function. */
    subscribe(listener: () => void): () => void;
    set(next: StateUpdate<T>): void;
    /** Rejects when unsupported, disposed or unconfirmed; never means business submission. */
    flush(): Promise<void>;
    dispose(): void;
  }
  export function createViewState<T extends Record<string, unknown>>(
    app: ConnectedApp, initial: T, options?: ViewStateOptions,
  ): ViewState<T>;
  export function flushViewState(app: ConnectedApp | null): Promise<void>;
}
declare module '@cindy/ext-apps/react' {
  import type { ConnectedApp, StateUpdate, ViewStateOptions } from '@cindy/ext-apps';
  /** Structural bindings use the author's own renderer instance and need no React type dependency. */
  export interface ReactHooks {
    useState<T>(initial: T | (() => T)): [T, (next: StateUpdate<T>) => void];
    useRef<T>(initial: T): { current: T };
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]): void;
    useCallback<T extends Function>(callback: T, deps: readonly unknown[]): T;
    useSyncExternalStore?<T>(subscribe: (listener: () => void) => () => void,
      getSnapshot: () => T, getServerSnapshot?: () => T): T;
  }
  export function createViewStateHooks(react: ReactHooks): {
    useViewState<T extends Record<string, unknown>>(
      app: ConnectedApp | null, initial: T, options?: ViewStateOptions,
    ): [T, (next: StateUpdate<T>) => void];
  };
}
