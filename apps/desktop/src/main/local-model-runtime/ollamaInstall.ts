import { createOllamaInstall } from '@cindy/model-providers/local-runtime/ollamaInstall';
import * as host from '../downloader/index.js';
export * from '@cindy/model-providers/local-runtime/ollamaInstall';
export const {
  windowsTarBin,
  readSidecarManifest,
  resolveOfficialSidecarAsset,
  resolveOfficialDarwinAsset,
  downloadOfficialAsset,
  extractOfficialArchive,
  extractDarwinArchive,
  installOfficialSidecar,
  installOfficialDarwinSidecar,
} = createOllamaInstall(host);
