/**
 * Images of a mail card whose task runs on another computer.
 *
 * Mail previews only load `data:` and this computer's `cindy-media:` images, and a remote card's
 * images (`cindy-media://blobs/…`) exist only on the task's computer. Their bytes come through the
 * existing remote media path (`cindy-remote-media://`, with its own persistent cache) and are shown
 * as `data:` URLs. Only the content addresses already validated in the card's mail data are asked
 * for; the saved draft keeps its `cid:` references (the editor restores them by CID).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { buildRemoteMediaUrl } from '../../shared/remoteMediaUrl';

const MAIL_IMAGE = /^cindy-media:\/\/blobs\/[a-f0-9]{64}\.(png|jpg|jpeg|gif|webp)$/;
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
/** Same bound as a mail attachment; larger images stay unshown rather than held in memory. */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

async function readAsDataUrl(deviceId: string, url: string): Promise<string | null> {
  const ext = MAIL_IMAGE.exec(url)?.[1];
  if (!ext) return null;
  const response = await fetch(buildRemoteMediaUrl({ kind: 'device', deviceId }, url));
  if (!response.ok) return null;
  const bytes = await response.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) return null;
  // The preview accepts only these image data URLs, so the type comes from the address, not the reply.
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(new Blob([bytes], { type: MIME[ext] }));
  });
}

/**
 * Returns where this window can load each image from: a `data:` URL once read, undefined until then
 * (or when it cannot be read). Without `deviceId` (a card of this computer) it returns `null`, and
 * the card's own addresses apply.
 */
export function useRemoteMailImages(deviceId: string | undefined, urls: readonly string[]): ((url: string) => string | undefined) | null {
  const [loaded, setLoaded] = useState<{ deviceId?: string; byUrl: ReadonlyMap<string, string> }>({ byUrl: new Map() });
  const requested = useRef<{ deviceId?: string; urls: Set<string> }>({ urls: new Set() });
  const wanted = deviceId ? [...new Set(urls.filter((url) => MAIL_IMAGE.test(url)))].sort().join('\n') : '';
  useEffect(() => {
    if (!deviceId || !wanted) return;
    if (requested.current.deviceId !== deviceId) requested.current = { deviceId, urls: new Set() };
    const asked = requested.current;
    let active = true;
    for (const url of wanted.split('\n')) {
      if (asked.urls.has(url)) continue;
      asked.urls.add(url);
      void readAsDataUrl(deviceId, url).catch(() => null).then((data) => {
        // A failed read may be tried again when the card is shown next time.
        if (!data) { asked.urls.delete(url); return; }
        if (!active) { asked.urls.delete(url); return; }
        setLoaded((prev) => {
          const byUrl = new Map(prev.deviceId === deviceId ? prev.byUrl : []);
          byUrl.set(url, data);
          return { deviceId, byUrl };
        });
      });
    }
    return () => { active = false; };
  }, [deviceId, wanted]);
  const resolve = useCallback(
    (url: string) => (loaded.deviceId === deviceId ? loaded.byUrl.get(url) : undefined),
    [loaded, deviceId],
  );
  return deviceId ? resolve : null;
}
