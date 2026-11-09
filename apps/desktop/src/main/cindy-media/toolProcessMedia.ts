import { ingestMedia } from './ingest';
import { materializeSshRemoteMedia } from '../file-browser/ssh-media';
import { createToolProcessMedia } from './toolProcessMediaCore';
export type { ToolMediaOrigin } from './toolProcessMediaCore';

export const materializeToolProcessMedia = createToolProcessMedia({ ingestMedia, materializeSshRemoteMedia });
