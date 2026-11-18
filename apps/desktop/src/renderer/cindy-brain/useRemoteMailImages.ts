/**
 * Images of a mail card whose task runs on another computer.
 *
 * Mail previews only load `data:` and this computer's `cindy-media:` images, and a remote card's
 * images (`cindy-media://blobs/…`) exist only on the task's computer. Their bytes come through the
 * existing remote media path (`cindy-remote-media://`, with its own persistent cache) and are shown
 * as `data:` URLs. Only the content addresses already validated in the card's mail data are asked
 * for; the saved draft keeps its `cid:` references (the editor restores them by CID).
 */
import { useCallback, useEffect, useState } from 'react';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, type DataOwnerGeneration } from '../contexts/dataOwnerGeneration';
import { buildRemoteMediaUrl } from '../../shared/remoteMediaUrl';

const MAIL_IMAGE = /^cindy-media:\/\/blobs\/[a-f0-9]{64}\.(png|jpg|jpeg|gif|webp)$/;
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
/** Same bound as a mail attachment; larger images stay unshown rather than held in memory. */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

async function readAsDataUrl(deviceId: string, url: string): Promise<string | null> {
  const ext = MAIL_IMAGE.exec(url)?.[1];
  if (!ext) return null;
  const { base64 } = await window.electronAPI.readImageBytes({ url: buildRemoteMediaUrl({ kind: 'device', deviceId }, url) });
  if (!base64 || base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) return null;
  // The preview accepts only image data URLs; use the validated address's MIME.
  return `data:${MIME[ext]};base64,${base64}`;
}

/**
 * Returns where this window can load each image from: a `data:` URL once read, undefined until then
 * (or when it cannot be read). Without `deviceId` (a card of this computer) it returns `null`, and
 * the card's own addresses apply.
 */
export function useRemoteMailImages(deviceId: string | undefined, urls: readonly string[]): ((url: string) => string | undefined) | null {
  const owner = getDataOwnerGeneration();
  const [loaded, setLoaded] = useState<{ owner?: DataOwnerGeneration; deviceId?: string; byUrl: ReadonlyMap<string, string> }>({ byUrl: new Map() });
  const wanted = deviceId ? [...new Set(urls.filter((url) => MAIL_IMAGE.test(url)))].sort().join('\n') : '';
  useEffect(() => {
    if (!deviceId || !wanted) return;
    let active = true;
    // Each effect owns its reads. A changed image list starts fresh reads through the existing
    // main-process media cache, so cleanup cannot strand an image as already requested.
    for (const url of wanted.split('\n')) {
      void readAsDataUrl(deviceId, url).catch(() => null).then((data) => {
        if (!data || !active || !isDataOwnerGenerationCurrent(owner)) return;
        setLoaded((prev) => {
          const byUrl = new Map(prev.owner === owner && prev.deviceId === deviceId ? prev.byUrl : []);
          byUrl.set(url, data);
          return { owner, deviceId, byUrl };
        });
      });
    }
    return () => { active = false; };
  }, [owner, deviceId, wanted]);
  const resolve = useCallback(
    (url: string) => (loaded.owner === owner && loaded.deviceId === deviceId ? loaded.byUrl.get(url) : undefined),
    [loaded, owner, deviceId],
  );
  return deviceId ? resolve : null;
}
