import { BrowserWindow, type Session, type WebContents } from 'electron';
import { isTrustedAppRendererWindow, isTrustedCindyRendererWindow } from '../security/trustedAppRenderer';

/** Remove desktop capture from the app session, including Chromium's legacy
 * chromeMediaSource path (reported as media with no physical mediaTypes).
 * Keep physical media and clipboard writes confined to trusted top-level pages. */
export function denyAppDesktopCapture(
  ses: Session,
  isVoiceInputOwner: (owner: WebContents) => boolean = () => false,
): void {
  const trusted = (owner: WebContents | null, details: { isMainFrame: boolean; requestingUrl?: string }) => {
    if (!owner || owner.isDestroyed() || !details.isMainFrame || details.requestingUrl !== owner.mainFrame.url)
      return false;
    const win = BrowserWindow.fromWebContents(owner);
    return isTrustedAppRendererWindow(win) || (isVoiceInputOwner(owner) && isTrustedCindyRendererWindow(win));
  };
  ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  ses.setPermissionCheckHandler((owner, permission, _origin, details) => {
    if (!trusted(owner, details)) return false;
    if (permission === 'media')
      return details.mediaType === 'audio' || details.mediaType === 'video';
    return permission === 'clipboard-sanitized-write';
  });
  ses.setPermissionRequestHandler((owner, permission, callback, details) => {
    if (!trusted(owner, details)) return callback(false);
    if (permission === 'media') {
      const types = 'mediaTypes' in details ? details.mediaTypes : undefined;
      return callback(
        Boolean(types?.length && types.every((type) => type === 'audio' || type === 'video')),
      );
    }
    callback(permission === 'clipboard-sanitized-write');
  });
}
