import { rememberIssuedClipboardText } from '../textClipboard.js';
import { localDbFatalDetailsText } from '../../shared/localDbFatalDetails.js';

/**
 * The fatal screen copies a startup failure's technical details through the main-process
 * clipboard, which only accepts text Main issued. Call this with every failed ensure-ready
 * result right before it is returned to the renderer, so the exact string the renderer
 * builds (`localDbFatalDetailsText`) is copyable.
 */
export function issueLocalDbFatalDetails(result: { ready: boolean; error?: { code?: string; message?: string } }): void {
  if (!result.ready) rememberIssuedClipboardText(localDbFatalDetailsText(result.error));
}
