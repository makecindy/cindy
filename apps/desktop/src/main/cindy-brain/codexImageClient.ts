import { createCodexImageChannel as createChannel, type CreateCodexImageChannelOptions } from '@cindy/app-runtime/media/codexImageClient';
import { createLogger } from '../logger.js';
export type { CreateCodexImageChannelOptions } from '@cindy/app-runtime/media/codexImageClient';
const log = createLogger('codex-image');
export function createCodexImageChannel(opts: CreateCodexImageChannelOptions) { return createChannel(opts, log); }
