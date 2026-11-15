import type { SessionFileOrigin } from './sessionFileOrigin';

/** Legacy callers share one in-app entry; the viewer dispatches by actual file type.
 * No opening side effect here: non-text attachments must not silently leave Cindy.
 * Resource access and remote resolution remain in the viewer's existing host adapters.
 */
export async function shouldOpenTextLightbox(filePath: string): Promise<boolean> {
  return filePath.length > 0;
}

export async function shouldOpenTextLightboxForOrigin(
  _ctx: { origin: SessionFileOrigin; workingDir: string },
  filePath: string,
): Promise<boolean> {
  return shouldOpenTextLightbox(filePath);
}
