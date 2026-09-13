import { requireOptionalNativeModule } from 'expo-modules-core';

interface CindyHtmlPreviewModule {
  start(root: string, entry: string, token: string, csp: string, files: string[][]): Promise<string>;
  stop(token: string): Promise<void>;
}
// An older installed binary can still open source view without crashing at import.
export default requireOptionalNativeModule<CindyHtmlPreviewModule>('CindyHtmlPreview');
