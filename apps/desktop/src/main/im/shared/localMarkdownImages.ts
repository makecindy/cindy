import fs from 'node:fs/promises';
import { resolveSafe as resolveCindyMediaUrl } from '../../cindy-media/blobStore';
import { resolveSafe as resolveXdtImageUrl } from '../../imageCacheStore';
import { materializeTaskImageText } from '../../cindy-media/taskImageDelivery';
import { materializeLocalMarkdownImages as materialize, type LocalMarkdownImageDeps } from '@cindy/media-core/local-markdown-images';
export type { MaterializedLocalMarkdownImages } from '@cindy/media-core/local-markdown-images';

const defaultDeps: LocalMarkdownImageDeps = {
  realpath: (value) => fs.realpath(value),
  stat: (value) => fs.stat(value),
  readFile: (value) => fs.readFile(value),
  materialize: materializeTaskImageText,
  resolveMediaUrl: (url) =>
    url.startsWith('cindy-media://') ? resolveCindyMediaUrl(url) : resolveXdtImageUrl(url),
};

export function materializeLocalMarkdownImages(params: Parameters<typeof materialize>[0], deps: LocalMarkdownImageDeps = defaultDeps) { return materialize(params, deps); }
