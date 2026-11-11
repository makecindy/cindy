import type { ViewProps } from 'react-native';
import { requireNativeViewManager } from 'expo-modules-core';
import native from '../../modules/cindy-html-preview/src/CindyHtmlPreviewModule';

// Old binaries can still show the saved text; never load a half-compatible
// interactive View or fall back to same-origin/opaque srcdoc.
export const mcpAppSurfaceAvailable = !!native?.appHostAvailable && !!native.startApp;
type Props = ViewProps & { surfaceId: string };
export const NativeMcpAppHost = mcpAppSurfaceAvailable
  ? requireNativeViewManager<Props>('CindyHtmlPreview', 'AppHost') : null;
export const NativeMcpAppSlot = mcpAppSurfaceAvailable
  ? requireNativeViewManager<Props>('CindyHtmlPreview', 'AppSlot') : null;
