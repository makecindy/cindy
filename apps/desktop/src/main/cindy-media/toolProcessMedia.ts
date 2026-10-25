import { createToolProcessMedia } from '@cindy/app-runtime/toolProcessMedia';
import { ingestMedia } from './ingest';
import { createLogger } from '../logger';
export type * from '@cindy/app-runtime/toolProcessMedia';
export const { materializeToolProcessMedia } = createToolProcessMedia({ ingestMedia, logger: createLogger('tool-process-media'), async materializeSshRemoteMedia(...args) { const ssh = await import('../file-browser/ssh-media'); return ssh.materializeSshRemoteMedia(...args); } });
