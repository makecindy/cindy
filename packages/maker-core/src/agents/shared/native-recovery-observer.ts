export type NativeRecoveryObserver = (sessionId: string) => NativeRecoverySink | undefined;

export interface NativeRecoverySink {
  publish(
    engine: 'claude-code' | 'codex' | 'pi',
    nativeEvent: string,
    metadata: Readonly<Record<string, string | number | boolean>>,
  ): void;
}
