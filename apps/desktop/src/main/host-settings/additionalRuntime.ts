import type { ChatEmbeddingDefaultContext } from '../maker-host/chat-embedding-settings-store.js';
interface AdditionalSettingsRuntime {
  chatEmbedding: { context(): ChatEmbeddingDefaultContext; available(): boolean; reconcile(): Promise<void> };
}
let runtime: AdditionalSettingsRuntime | null = null;
export function configureAdditionalSettingsRuntime(value: AdditionalSettingsRuntime) { runtime = value; }
export function additionalSettingsRuntime() { return runtime; }

let modelRuntime: { refreshContext(): Promise<void>; accessChanged(): void; refreshTools(): Promise<void>; pricingChanged(): void } | null = null;
export function configureAdditionalModelRuntime(value: NonNullable<typeof modelRuntime>) { modelRuntime = value; }
export function additionalModelRuntime() { return modelRuntime; }

type NativeOperations = typeof import('./additionalNative.js').nativeSettingsOperations;
let nativeOperations: NativeOperations | null = null;
export function configureAdditionalNativeOperations(value: NativeOperations) { nativeOperations = value; }
export function additionalNativeOperations() { return nativeOperations; }
