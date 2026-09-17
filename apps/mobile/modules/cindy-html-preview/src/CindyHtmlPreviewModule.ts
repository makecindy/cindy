import { requireOptionalNativeModule } from 'expo-modules-core';

interface CindyHtmlPreviewModule {
  start(root: string, entry: string, token: string, csp: string, files: string[][]): Promise<string>;
  startOnDemand?(root: string, entry: string, token: string, csp: string): Promise<string>;
  resolveRequest?(token: string, id: string, filename: string, mime: string, status: number): Promise<boolean>;
  addListener(event: 'resourceRequest' | 'resourceClosed', listener: (event: { token: string; id: string; path?: string }) => void): { remove(): void };
  stop(token: string): Promise<void>;
}
// An older installed binary can still open source view without crashing at import.
export default requireOptionalNativeModule<CindyHtmlPreviewModule>('CindyHtmlPreview');
